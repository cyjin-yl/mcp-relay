import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { resolveInsideRoot } from "./paths.js";

const OUTPUT_CAP = 64 * 1024;

export type ShellResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

export type ResolvedShell = { path: string; args: string[] };

let cachedShell: { environment: string; shell: ResolvedShell } | null = null;

function executable(path: string): string | null {
  try {
    // Resolve against the daemon's cwd before spawn changes to the tool cwd.
    // Otherwise a relative override/PATH entry could select another file.
    const absolute = resolve(path);
    if (!statSync(absolute).isFile()) return null;
    accessSync(absolute, constants.X_OK);
    return absolute;
  } catch {
    return null;
  }
}

function resolveExecutable(command: string): string | null {
  if (command.includes("/") || isAbsolute(command)) return executable(command);
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    ...(process.env.PREFIX ? [join(process.env.PREFIX, "bin")] : []),
    "/data/data/com.termux/files/usr/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];
  for (const dir of dirs) {
    const found = executable(join(dir, command));
    if (found) return found;
  }
  return null;
}

export function resolveShell(): ResolvedShell {
  // Reuse resolution only while the explicit shell-selection environment and
  // executable remain valid. Tests and embedded callers may change the env.
  const environment = JSON.stringify([
    process.env.MCP_RELAY_BASH, process.env.PREFIX, process.env.PATH, process.env.SHELL
  ]);
  if (cachedShell?.environment === environment && executable(cachedShell.shell.path)) {
    return cachedShell.shell;
  }
  const candidates = [
    process.env.MCP_RELAY_BASH,
    process.env.PREFIX ? join(process.env.PREFIX, "bin", "bash") : undefined,
    "/data/data/com.termux/files/usr/bin/bash",
    "/bin/bash",
    "/usr/local/bin/bash",
    "/usr/bin/bash",
    "bash",
    process.env.SHELL,
    "/system/bin/sh",
    "/bin/sh",
    "sh"
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    const path = resolveExecutable(candidate);
    if (!path) continue;
    // Login profiles can run unrelated startup hooks. Preserve portable shell
    // resolution without charging those hooks to every tool execution budget.
    const shell: ResolvedShell = { path, args: ["-c"] };
    cachedShell = { environment, shell };
    return shell;
  }
  throw new Error(
    "no executable shell found; install bash or set MCP_RELAY_BASH to its absolute path"
  );
}

export function shellEnvironment(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MCP_RELAY: "1" };
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "PREFIX"];
  if (platform === "android") {
    // Android's app_process/ART and Termux-X11 need these system paths even
    // for --help. Keep the allowlist explicit; never copy the caller's env.
    keys.push("ANDROID_DATA", "ANDROID_ROOT", "ANDROID_RUNTIME_ROOT", "ANDROID_ART_ROOT",
      "ANDROID_I18N_ROOT", "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH", "DEX2OATBOOTCLASSPATH");
  }
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function runShell(
  root: string,
  command: string,
  cwdInput: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform
): Promise<ShellResult> {
  if (platform === "win32") {
    return Promise.reject(new Error("bash tool is not available on Windows devices"));
  }
  signal?.throwIfAborted();
  const cwd = cwdInput ? resolveInsideRoot(root, cwdInput) : root;
  const shell = resolveShell();
  return new Promise((resolve, reject) => {
    const child = spawn(shell.path, [...shell.args, command], {
      cwd,
      env: shellEnvironment(platform),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const append = (current: string, chunk: Buffer): { text: string; truncated: boolean } => {
      if (current.length >= OUTPUT_CAP) return { text: current, truncated: true };
      const next = current + chunk.toString("utf8");
      if (next.length > OUTPUT_CAP) {
        return { text: next.slice(0, OUTPUT_CAP), truncated: true };
      }
      return { text: next, truncated: false };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const r = append(stdout, chunk);
      stdout = r.text;
      stdoutTruncated ||= r.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const r = append(stderr, chunk);
      stderr = r.text;
      stderrTruncated ||= r.truncated;
    });

    const stop = () => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    // No await occurs between the initial check and listener registration.
    // This check also covers a custom signal that was already aborted.
    if (signal?.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });
  });
}
