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

export function shellEnvironment(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MCP_RELAY: "1" };
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
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
  return new Promise((resolve, reject) => {
    // Commands inherit the explicit environment below. Login profiles can run
    // unrelated startup hooks and must not consume a tool's execution budget.
    // Termux installs bash under its private prefix, not /bin. Resolve it from
    // the same explicit PATH passed to the child, without relying on Android's
    // optional LD_PRELOAD exec-path rewriting hook in the parent Node process.
    const shell = platform === "android" ? "bash" : "/bin/bash";
    const child = spawn(shell, ["-c", command], {
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
