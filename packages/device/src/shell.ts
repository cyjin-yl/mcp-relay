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

function filteredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MCP_RELAY: "1" };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"]) {
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
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
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
