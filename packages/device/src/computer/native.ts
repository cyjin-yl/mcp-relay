import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { shellEnvironment } from "../shell.js";
import { ComputerError, type NativeCommand, type NativeContext, type NativeResult } from "./types.js";

const HARD_OUTPUT_LIMIT = 24 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== "win32") return env[key];
  const found = Object.keys(env).find(k => k.toUpperCase() === key.toUpperCase());
  return found === undefined ? undefined : env[found];
}

/** Explicit environment allowlist: do not pass provider credentials to UI helpers. */
export function nativeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = shellEnvironment(process.platform, source);
  for (const key of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "LC_CTYPE",
    "USER", "LOGNAME", "USERDOMAIN", "USERNAME", "SESSIONNAME", "__CF_USER_TEXT_ENCODING"]) {
    const item = value(source, key);
    if (item !== undefined) env[key] = item;
  }
  return env;
}

export function findExecutable(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = process.platform === "win32";
  const dirs = (value(env, "PATH") ?? "").split(windows ? ";" : ":").filter(Boolean);
  const extensions = windows ? ["", ...(value(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const name of names) {
    const paths = isAbsolute(name) || /[\\/]/.test(name) ? [name] : dirs.map(dir => join(dir, name));
    for (const base of paths) for (const ext of extensions) {
      const path = base + ext;
      try {
        if (!statSync(path).isFile()) continue;
        if (!windows) accessSync(path, constants.X_OK);
        // Native helpers never invoke cmd.exe or a shell implicitly.
        if (windows && /\.(?:cmd|bat)$/i.test(path)) continue;
        return path;
      } catch { /* try the next candidate */ }
    }
  }
  return undefined;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
}

async function terminate(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const root = value(env, "SYSTEMROOT") ?? "C:\\Windows";
    await new Promise<void>(resolve => {
      const killer = spawn(join(root, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, env });
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { killer.kill(); finish(); }, 2000);
      killer.once("error", finish);
      killer.once("exit", finish);
    });
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* child exit is observed by caller */ }
    }
    return;
  }
  const group = child.pid;
  signalGroup(child, "SIGTERM");
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); child.off("exit", onExit); resolve(); } };
    const onExit = () => {
      // A helper can exit before its descendants. A surviving original process
      // group still owns this PGID; do not release its input transaction yet.
      try { process.kill(-group, 0); } catch { finish(); }
    };
    const timer = setTimeout(() => {
      try { process.kill(-group, "SIGKILL"); } catch { /* original group is gone */ }
      finish();
    }, 250);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

/** Spawn without a shell, retain binary output, and never release the caller before child exit. */
export async function runNative(spec: NativeCommand, ctx: NativeContext): Promise<NativeResult> {
  if (ctx.signal?.aborted) throw new ComputerError("cancelled", "Computer action was cancelled before execution.");
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs < 1 || ctx.timeoutMs > 120000) {
    throw new ComputerError("invalid_timeout", "Native command timeout must be 1–120000 ms.");
  }
  const maxOutput = Math.min(spec.maxOutputBytes ?? 2 * 1024 * 1024, HARD_OUTPUT_LIMIT);
  if (maxOutput < 1) throw new ComputerError("invalid_output_limit", "Invalid native output limit.");
  const env = nativeEnvironment(spec.env ?? process.env);
  return new Promise<NativeResult>((resolve, reject) => {
    const out: Buffer[] = [], err: Buffer[] = [];
    let outSize = 0, errSize = 0, exitCode = -1;
    let exited = false, closed = false, settled = false, stopping = false;
    let failure: ComputerError | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true,
      detached: process.platform !== "win32", shell: false
    });
    const settle = () => {
      if (settled || !exited || !closed || stopping) return;
      settled = true;
      clearTimeout(timeout);
      if (grace) clearTimeout(grace);
      ctx.signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(out, outSize), stderr: Buffer.concat(err, errSize), exitCode });
    };
    const stop = (error: ComputerError) => {
      failure ??= error;
      if (stopping || exited) { settle(); return; }
      stopping = true;
      void terminate(child, env).finally(() => { stopping = false; settle(); });
    };
    const onAbort = () => stop(new ComputerError("cancelled", "Computer action was cancelled.", { mayHaveApplied: true }));
    const timeout = setTimeout(() => stop(new ComputerError("timeout",
      "Native computer command exceeded its deadline.", { mayHaveApplied: true })), ctx.timeoutMs);
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    // Close only this process's streams after exit; background descendants must not keep a writer slot forever.
    child.once("exit", (code, signal) => {
      exited = true; exitCode = code ?? (signal ? 128 : -1);
      grace = setTimeout(() => { closed = true; settle(); }, 300);
      settle();
    });
    child.once("close", () => { closed = true; settle(); });
    child.on("error", error => {
      const cause = (error as NodeJS.ErrnoException).code ?? "unknown";
      if (!child.pid) {
        failure ??= new ComputerError("native_spawn_failed", "Could not start the native computer helper.",
          { cause, mayHaveApplied: false });
        exited = true; closed = true; settle();
        return;
      }
      // A spawned process also emits error when a signal cannot be delivered.
      // That is not an exit: retain the transaction until real exit/cleanup,
      // including repeated errors while terminate() is already in progress.
      stop(new ComputerError("native_process_failed", "The native computer helper reported a process error.",
        { cause, mayHaveApplied: true }));
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (outSize + chunk.length > maxOutput) {
        stop(new ComputerError("output_too_large", "Native computer output exceeded its size limit.", { mayHaveApplied: true }));
        return;
      }
      out.push(chunk); outSize += chunk.length;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errSize >= STDERR_LIMIT) return;
      const part = chunk.subarray(0, STDERR_LIMIT - errSize);
      err.push(part); errSize += part.length;
    });
    child.stdin!.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        stop(new ComputerError("native_input_failed", "Could not write input to the native helper.", { mayHaveApplied: true }));
      }
    });
    child.stdin!.end(spec.input);
    if (ctx.signal?.aborted) onAbort();
  });
}

export function pngDimensions(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)
    || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new ComputerError("invalid_screenshot", "Native helper did not return a PNG screenshot.");
  }
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 32768 || height > 32768 || width * height > 120000000) {
    throw new ComputerError("invalid_screenshot", "Screenshot dimensions exceed supported limits.");
  }
  return { width, height };
}
