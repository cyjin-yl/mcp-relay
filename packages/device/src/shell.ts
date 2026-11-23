import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
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

let cachedShell: ResolvedShell | null = null;

function executable(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    accessSync(path, constants.X_OK);
    return path;
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
  if (cachedShell) return cachedShell;
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
    const bashLike = /bash$/i.test(path);
    cachedShell = { path, args: bashLike ? ["-lc"] : ["-c"] };
    return cachedShell;
  }
  throw new Error(
    "no executable shell found; install bash or set MCP_RELAY_BASH to its absolute path"
  );
}

function filteredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MCP_RELAY: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "PREFIX",
    "ANDROID_ROOT",
    "ANDROID_DATA"
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function runShell(
  root: string,
  command: string,
  cwdInput: string | undefined,
  timeoutMs: number
): Promise<ShellResult> {
  if (process.platform === "win32") {
    return Promise.reject(new Error("bash tool is not available on Windows devices"));
  }
  const cwd = cwdInput ? resolveInsideRoot(root, cwdInput) : root;
  const shell = resolveShell();
  return new Promise((resolve, reject) => {
    const child = spawn(shell.path, [...shell.args, command], {
      cwd,
      env: filteredEnv(),
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

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
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
