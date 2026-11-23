import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveInsideRoot } from "./paths.js";

const OUTPUT_CAP = 64 * 1024;
const EXIT_STDIO_GRACE_MS = 1000;
export type ShellKind = "bash" | "powershell";

export type ShellResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

function environmentValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function shellEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MCP_RELAY: "1" };
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
  if (platform === "android") {
    // Android's app_process/ART and Termux-X11 need these system paths even
    // for --help. Never forward credentials or preload hooks.
    keys.push("ANDROID_DATA", "ANDROID_ROOT", "ANDROID_RUNTIME_ROOT", "ANDROID_ART_ROOT",
      "ANDROID_I18N_ROOT", "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH", "DEX2OATBOOTCLASSPATH");
  }
  if (platform === "win32") {
    // Windows environment names are case insensitive. Emit one canonical key
    // per name so Node does not pick a different duplicate PATH entry.
    keys.push("SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
      "TEMP", "TMP", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
      "SYSTEMDRIVE", "PSMODULEPATH");
  }
  for (const key of keys) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isWslBash(path: string): boolean {
  return /[\\/]Windows[\\/](System32|Sysnative)[\\/]bash\.exe$/i.test(path)
    || /[\\/]Microsoft[\\/]WindowsApps[\\/]bash\.exe$/i.test(path);
}

function fileExists(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

export function resolveShellProgram(
  kind: ShellKind,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== "win32") {
    if (kind === "powershell") throw new Error("powershell is available only on Windows devices; use bash");
    // Termux installs bash in its private PATH, not /bin.
    return platform === "android" ? "bash" : "/bin/bash";
  }
  const value = (name: string) => environmentValue(source, name, platform);
  const candidates: string[] = [];
  const override = value(kind === "bash" ? "MCP_RELAY_BASH" : "MCP_RELAY_POWERSHELL");
  if (override) {
    if (!win32.isAbsolute(override) || !/\.exe$/i.test(override) || !fileExists(override)
      || (kind === "bash" && isWslBash(override))) {
      throw new Error("the configured " + kind + " executable must be an existing absolute .exe path");
    }
    return override;
  }
  const programDirs = [value("PROGRAMW6432"), value("PROGRAMFILES"), value("PROGRAMFILES(X86)")]
    .filter((dir): dir is string => Boolean(dir));
  if (kind === "powershell") {
    for (const dir of programDirs) candidates.push(win32.join(dir, "PowerShell", "7", "pwsh.exe"));
    const systemRoot = value("SYSTEMROOT") ?? value("WINDIR") ?? "C:\\Windows";
    candidates.push(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  } else {
    for (const dir of programDirs) {
      candidates.push(win32.join(dir, "Git", "bin", "bash.exe"), win32.join(dir, "Git", "usr", "bin", "bash.exe"));
    }
    const local = value("LOCALAPPDATA");
    if (local) candidates.push(win32.join(local, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const dir of (value("PATH") ?? "").split(";").filter(Boolean)) {
    const path = win32.join(dir.replace(/^"|"$/g, ""), kind === "bash" ? "bash.exe" : "pwsh.exe");
    // Windows' legacy WSL launcher is not a native Bash: its cwd/root and
    // environment refer to a different filesystem.
    if (kind !== "bash" || !isWslBash(path)) {
      candidates.push(path);
    }
  }
  const found = candidates.find(fileExists);
  if (found) return found;
  throw new Error(kind === "bash"
    ? "native Bash was not found; use the powershell tool or install Git for Windows"
    : "PowerShell was not found; set MCP_RELAY_POWERSHELL to its absolute executable path");
}

export function shellAvailable(kind: ShellKind, platform: NodeJS.Platform = process.platform): boolean {
  try { resolveShellProgram(kind, platform); return true; } catch { return false; }
}

function powershellArguments(command: string): string[] {
  // UTF-16LE -EncodedCommand preserves quotes, Unicode and multiline scripts
  // without passing through cmd.exe; output is consistently UTF-8 even on 5.1.
  const script = [
    "$relayUtf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $relayUtf8",
    "[Console]::OutputEncoding = $relayUtf8",
    "$OutputEncoding = $relayUtf8",
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$LASTEXITCODE = 0",
    "try {",
    "& {",
    command,
    "}",
    "$relaySucceeded = $?",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "if (-not $relaySucceeded) { exit 1 }",
    "} catch {",
    "[Console]::Error.WriteLine($_.ToString())",
    "exit 1",
    "}"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function stopWindowsTree(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!child.pid) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let finished = false;
    let killer: ChildProcess | undefined;
    let fallback: NodeJS.Timeout | undefined;
    const finish = (failed: boolean) => {
      if (finished) return;
      finished = true;
      if (fallback) clearTimeout(fallback);
      if (failed) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        try { killer?.kill("SIGKILL"); } catch { /* already exited */ }
      }
      resolve(failed ? "[mcp-relay] taskkill could not confirm the full process tree; fallback termination requested for pid " + child.pid : undefined);
    };
    try {
      const systemRoot = env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows";
      killer = spawn(win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { env, windowsHide: true, stdio: "ignore" });
      killer.once("error", () => finish(true));
      killer.once("close", (code) => finish(code !== 0));
      fallback = setTimeout(() => finish(true), 5000);
    } catch { finish(true); }
  });
}

export function runShell(
  root: string,
  command: string,
  cwdInput: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  kind: ShellKind = "bash"
): Promise<ShellResult> {
  signal?.throwIfAborted();
  const cwd = cwdInput ? resolveInsideRoot(root, cwdInput) : root;
  const shell = resolveShellProgram(kind, platform);
  const env = shellEnvironment(platform);
  const args = kind === "powershell" ? powershellArguments(command) : ["--noprofile", "--norc", "-c", command];
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      env,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    let settled = false;
    let stdioTimer: NodeJS.Timeout | undefined;
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const append = (current: string, chunk: string): { text: string; truncated: boolean } => {
      if (chunk.length === 0) return { text: current, truncated: false };
      if (current.length >= OUTPUT_CAP) return { text: current, truncated: true };
      const next = current + chunk;
      if (next.length > OUTPUT_CAP) return { text: next.slice(0, OUTPUT_CAP), truncated: true };
      return { text: next, truncated: false };
    };
    const appendOut = (text: string) => {
      const result = append(stdout, text);
      stdout = result.text; stdoutTruncated ||= result.truncated;
    };
    const appendErr = (text: string) => {
      const result = append(stderr, text);
      stderr = result.text; stderrTruncated ||= result.truncated;
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOut(outDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => appendErr(errDecoder.write(chunk)));

    const stop = () => {
      if (timedOut) return;
      timedOut = true;
      if (platform === "win32") {
        termination = stopWindowsTree(child, env).then((warning) => {
          if (warning) appendErr(warning + "\n");
        });
      } else {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      if (stdioTimer) clearTimeout(stdioTimer);
      signal?.removeEventListener("abort", stop);
    };

    const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      appendOut(outDecoder.end());
      appendErr(errDecoder.end());
      const deliver = () => resolve({ exitCode: code, signal: exitSignal, stdout, stderr,
        stdoutTruncated, stderrTruncated, timedOut });
      if (termination) void termination.then(deliver);
      else deliver();
    };
    child.on("error", (error) => {
      if (settled) return;
      if (child.pid !== undefined) {
        // A failed kill can emit "error" for a still-running process. Keep
        // ownership until its real exit rather than letting another writer in.
        appendErr("[mcp-relay] shell process error: " + error.message + "\n");
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("exit", (code, exitSignal) => {
      // A deliberately detached background child can inherit these pipes.
      // The requested shell is already gone: let its buffered output drain,
      // then close our pipe ends without signalling the background process.
      // Never release the writer lane on a timer while the shell is alive.
      stdioTimer = setTimeout(() => {
        if (settled) return;
        stdoutTruncated ||= child.stdout?.readableEnded === false;
        stderrTruncated ||= child.stderr?.readableEnded === false;
        appendErr("[mcp-relay] shell exited; closed inherited output pipes after the drain grace period. Background processes may still be running.\n");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, exitSignal);
      }, EXIT_STDIO_GRACE_MS);
      stdioTimer.unref();
    });
    child.on("close", finish);
  });
}
