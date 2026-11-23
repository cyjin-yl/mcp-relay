/**
 * Read-only PS5 cmdlet/environment diagnostic. Build in CT102; run only the
 * prebuilt file on an ephemeral Windows runner. No UI or host configuration changes.
 * Environment values and command error text are deliberately not persisted.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { nativeEnvironment } from "../../src/computer/native.js";

type Env = NodeJS.ProcessEnv;
type Event = { name: string; ms: number; code?: string | number | null };
type Result = {
  name: string; addedKeys: string[]; removedKeys: string[]; renamedKeys: string[];
  events: Event[]; stdoutBytes: number; stderrBytes: number; markers: string[];
  timedOut: boolean; exitCode?: number | null; signal?: string | null;
  cleanupUncertain?: boolean; elapsedMs?: number; passed?: boolean;
};
const CASE_MS = 8000;
const CLEANUP_MS = 2600;
const TOTAL_MS = 115000;
const PREFIX = ["-NoLogo", "-NoProfile", "-NonInteractive"];
const BEGIN = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "trap{[Console]::Error.WriteLine('DIAG:ERROR');exit 2};" +
  "[Console]::Error.WriteLine('DIAG:ENTER');";
const DONE = ";[Console]::WriteLine('DIAG:OK');exit 0";
const VERSION = BEGIN +
  "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);" +
  "[Console]::Error.WriteLine('DIAG:ENCODING_READY');" +
  "$j=@{version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress;" +
  "[Console]::Error.WriteLine('DIAG:JSON_READY')" + DONE;
const NATIVE_DOTNET = BEGIN +
  "$e=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$e;" +
  "[Console]::Error.WriteLine('DIAG:DOTNET_ENCODING_READY')" + DONE;
const NEW_OBJECT = BEGIN +
  "$e=New-Object Text.UTF8Encoding($false);" +
  "[Console]::Error.WriteLine('DIAG:NEW_OBJECT_READY')" + DONE;
const CONVERT_JSON = BEGIN +
  "$j=@{version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress;" +
  "[Console]::Error.WriteLine('DIAG:CONVERT_JSON_READY')" + DONE;
const EXPLICIT_IMPORT = BEGIN +
  "Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop;" +
  "[Console]::Error.WriteLine('DIAG:IMPORT_READY');" +
  "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);" +
  "$j=@{version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress" + DONE;

function findKey(env: Env, key: string): string | undefined {
  return Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase());
}
function value(env: Env, key: string): string | undefined {
  const name = findKey(env, key);
  return name === undefined ? undefined : env[name];
}
function without(env: Env, key: string): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== key.toLowerCase()));
}
function diffKeys(base: Env, other: Env) {
  const b = new Map(Object.keys(base).map(k => [k.toLowerCase(), k]));
  const o = new Map(Object.keys(other).map(k => [k.toLowerCase(), k]));
  return {
    addedKeys: [...o].filter(([k]) => !b.has(k)).map(([, k]) => k).sort(),
    removedKeys: [...b].filter(([k]) => !o.has(k)).map(([, k]) => k).sort(),
    renamedKeys: [...o].filter(([k, v]) => b.has(k) && b.get(k) !== v).map(([k, v]) => b.get(k) + "->" + v).sort()
  };
}
function policyObservation(env: Env, name: string, allowed: string[]) {
  const key = findKey(env, name);
  if (!key) return { present: false };
  const raw = env[key] ?? "";
  const known = allowed.find(item => item.toLowerCase() === raw.toLowerCase());
  return { present: true, state: known ?? "other-redacted" };
}

async function probe(command: string, name: string, env: Env, script: string, baseline: Env): Promise<Result> {
  const start = performance.now();
  const result: Result = { name, ...diffKeys(baseline, env), events: [], stdoutBytes: 0,
    stderrBytes: 0, markers: [], timedOut: false };
  const event = (name: string, code?: string | number | null) => {
    result.events.push({ name, ms: Math.round(performance.now() - start), ...(code === undefined ? {} : { code }) });
  };
  return new Promise(resolveResult => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...PREFIX, "-Command", script], { env, shell: false,
        windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      event("spawn-throw", (error as NodeJS.ErrnoException).code ?? "unknown");
      result.elapsedMs = Math.round(performance.now() - start);
      result.passed = false;
      resolveResult(result);
      return;
    }
    let ended = false, exited = false, rawStdout = "", rawStderr = "";
    let grace: NodeJS.Timeout | undefined, hardStop: NodeJS.Timeout | undefined;
    let killer: ChildProcess | undefined, killerDeadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (hardStop) clearTimeout(hardStop);
      if (killerDeadline) clearTimeout(killerDeadline);
      if (killer && killer.exitCode === null && killer.signalCode === null) {
        try { killer.kill("SIGKILL"); } catch { /* recorded by child cleanup state */ }
        killer.unref();
      }
      child.stdout?.destroy(); child.stderr?.destroy();
      if (!exited && child.pid) child.unref();
      // Keep only our fixed alphabetic milestones. Never persist raw errors/paths/environment values.
      result.markers = [...(rawStdout + "\n" + rawStderr).matchAll(/\bDIAG:[A-Z_]+\b/g)]
        .map(match => match[0]).slice(0, 40);
      result.elapsedMs = Math.round(performance.now() - start);
      result.passed = !result.timedOut && result.exitCode === 0 && result.markers.includes("DIAG:OK");
      resolveResult(result);
    };
    const deadline = setTimeout(() => {
      result.timedOut = true;
      event("deadline", CASE_MS);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const taskkill = win32.join(value(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "taskkill.exe");
        killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"],
          { env: process.env, stdio: "ignore", windowsHide: true });
        killer.on("error", error => {
          event("taskkill-error", (error as NodeJS.ErrnoException).code ?? "unknown");
          try { child.kill("SIGKILL"); } catch { /* hard stop records uncertainty */ }
        });
        killer.once("exit", code => {
          event("taskkill-exit", code);
          if (!exited) { try { child.kill("SIGKILL"); } catch { /* hard stop below */ } }
        });
        killerDeadline = setTimeout(() => {
          try { killer?.kill("SIGKILL"); if (!exited) child.kill("SIGKILL"); } catch { /* hard stop below */ }
        }, 2000);
      }
      hardStop = setTimeout(() => {
        if (!exited) { result.cleanupUncertain = true; event("owned-child-exit-not-observed"); }
        finish();
      }, CLEANUP_MS);
    }, CASE_MS);
    child.once("spawn", () => event("spawn"));
    child.on("error", error => {
      event("child-error", (error as NodeJS.ErrnoException).code ?? "unknown");
      if (!child.pid) finish();
    });
    child.once("exit", (code, signal) => {
      exited = true; result.exitCode = code; result.signal = signal;
      event("exit", code);
      grace = setTimeout(() => { event("stdio-grace-expired"); finish(); }, 400);
    });
    child.once("close", code => { event("close", code); finish(); });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!result.stdoutBytes) event("first-stdout");
      result.stdoutBytes += chunk.length;
      if (rawStdout.length < 32768) rawStdout += chunk.toString("utf8").slice(0, 32768 - rawStdout.length);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (!result.stderrBytes) event("first-stderr");
      result.stderrBytes += chunk.length;
      if (rawStderr.length < 32768) rawStderr += chunk.toString("utf8").slice(0, 32768 - rawStderr.length);
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("This prebuilt diagnostic requires Windows.");
  const directory = resolve(process.argv[2] ?? "windows-native-environment-diagnostic");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = performance.now();
  const full = { ...process.env }, minimal = nativeEnvironment(full);
  const command = win32.join(value(full, "SystemRoot") ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(command)) throw new Error("System Windows PowerShell is absent.");
  const originalCase = Object.fromEntries(Object.entries(minimal).map(([key, val]) => [findKey(full, key) ?? key, val]));
  const moduleCase = without(minimal, "PSModulePath");
  const originalModule = value(minimal, "PSModulePath");
  if (originalModule !== undefined) moduleCase.PSModulePath = originalModule;
  const noModules = without(minimal, "PSModulePath");
  const osModules = { ...noModules, PSModulePath: win32.join(value(full, "SystemRoot") ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "Modules") };
  const groups: Record<string, string[]> = {
    profileCommon: ["ALLUSERSPROFILE", "PROGRAMDATA", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
      "COMMONPROGRAMW6432", "HOMEDRIVE", "HOMEPATH", "PUBLIC"],
    machine: ["COMPUTERNAME", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "PROCESSOR_IDENTIFIER",
      "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS", "OS"],
    moduleCache: ["PSModuleAnalysisCachePath"]
  };
  // Use the source key spelling and exact already-present value; never synthesize a policy override.
  const groupKeys = Object.fromEntries(Object.entries(groups).map(([group, names]) => [group,
    names.map(name => findKey(full, name)).filter((key): key is string => key !== undefined && findKey(minimal, key) === undefined)]));
  const safeKeys = [...new Set(Object.values(groupKeys).flat())];
  const restore = (keys: string[]): Env => ({ ...minimal, ...Object.fromEntries(keys.map(key => [key, full[key]])) });
  const cases: Result[] = [];
  const report: Record<string, unknown> = {
    schemaVersion: 2, purpose: "read-only-ps51-environment-and-cmdlet-initialization",
    platform: process.platform, node: process.version, startedAt: new Date().toISOString(),
    executableKind: "system-WindowsPowerShell-v1.0", caseDeadlineMs: CASE_MS,
    totalBudgetMs: TOTAL_MS, cases, availableSafeKeyGroups: groupKeys,
    originalNativeKeyNames: Object.keys(minimal).sort(), originalSourceAllowedKeyNames: Object.keys(originalCase).sort(),
    observedPolicyVariables: {
      PSExecutionPolicyPreference: policyObservation(full, "PSExecutionPolicyPreference",
        ["AllSigned", "Bypass", "Default", "RemoteSigned", "Restricted", "Undefined", "Unrestricted"]),
      __PSLockdownPolicy: policyObservation(full, "__PSLockdownPolicy", ["0", "1", "2", "3", "4", "5", "6", "7", "8"])
    },
    policyVariablesAddedToChild: false, environmentValuesPrinted: false,
    uiInputPerformed: false, capabilityVerdict: "not-assessed-by-this-diagnostic",
    diagnosticSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"),
    skippedCases: [] as Array<{ name: string; reason: string }>
  };
  const persist = () => writeFileSync(join(directory, "diagnostic-progress.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const run = async (name: string, env: Env, script = VERSION): Promise<Result | undefined> => {
    if (performance.now() - started + CASE_MS + CLEANUP_MS + 500 >= TOTAL_MS) {
      (report.skippedCases as Array<{name: string; reason: string}>).push({ name, reason: "total-budget-reserved-for-cleanup" });
      persist();
      return undefined;
    }
    const result = await probe(command, name, env, script, minimal);
    cases.push(result); persist();
    if (result.cleanupUncertain) throw new Error("Owned child exit was not observed; subsequent cases stopped.");
    return result;
  };
  try {
    await run("01-native-dotnet-constructor", minimal, NATIVE_DOTNET);
    await run("02-native-original-key-casing", originalCase);
    await run("03-native-module-key-casing-only", moduleCase);
    await run("04-native-delete-module-path", noModules);
    await run("05-native-os-module-path-only", osModules);
    const allSafe = await run("06-native-all-existing-safe-fields", restore(safeKeys));
    await run("07-native-new-object-only", minimal, NEW_OBJECT);
    await run("08-native-convert-json-only", minimal, CONVERT_JSON);
    await run("09-native-explicit-utility-import", minimal, EXPLICIT_IMPORT);
    if (allSafe?.passed && safeKeys.length) {
      let sufficient: string[] | undefined;
      const groupOutcomes: Record<string, boolean | "not-run"> = {};
      for (const [group, keys] of Object.entries(groupKeys)) {
        if (!keys.length) continue;
        const result = await run("safe-group-" + group, restore(keys));
        groupOutcomes[group] = result ? Boolean(result.passed) : "not-run";
        if (result?.passed && sufficient === undefined) sufficient = keys;
      }
      report.safeGroupOutcomes = groupOutcomes;
      if (sufficient) {
        let attempts = 0;
        while (sufficient.length > 1 && attempts < 4) {
          const middle = Math.ceil(sufficient.length / 2);
          let found = false;
          for (const [side, keys] of [["a", sufficient.slice(0, middle)], ["b", sufficient.slice(middle)]] as const) {
            if (!keys.length || attempts >= 4) continue;
            attempts++;
            const result = await run("safe-subset-" + attempts + "-" + side, restore([...keys]));
            if (!result) { attempts = 4; break; }
            if (result.passed) { sufficient = [...keys]; found = true; break; }
          }
          if (!found) break; // Could be an interaction; never infer a single causal key.
        }
        report.smallestObservedSufficientSafeKeys = sufficient;
        report.safeSubsetProbeCount = attempts;
        report.safeKeyCausality = "observed-sufficiency-only; no uniqueness-or-necessity-claim";
      }
    }
    report.status = "diagnostic-completed";
  } catch (error) {
    report.status = "diagnostic-stopped";
    report.error = error instanceof Error ? error.message : "diagnostic-failed";
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    report.elapsedMs = Math.round(performance.now() - started);
    writeFileSync(join(directory, "diagnostic.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
main().catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "diagnostic-failed\n"); process.exitCode = 1; });
