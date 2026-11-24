import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { findExecutable, nativeEnvironment, pngDimensions } from "./native.js";
import { waylandHelper } from "./wayland-helper.js";
import { ComputerError, type ComputerBackend, type ComputerState, type NativeContext } from "./types.js";

const OUTPUT_LIMIT = 17 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 300000;
type Operation = "inspect" | "setup" | "screenshot" | "act";
type Pending = {
  id: string;
  operation: Operation;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  finish: () => void;
};
type Running = {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  pending?: Pending;
  failure?: ComputerError;
  stopping?: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
  pieces: Buffer[];
  bytes: number;
  stderrBytes: number;
};

export interface WaylandPortalClientOptions {
  /** Native fixture injection; never read from tool arguments or a relay config. */
  python?: string;
  source?: string;
  idleTimeoutMs?: number;
}

/** One private stdio channel owns one portal permission session and its DBus connection. */
export class WaylandPortalClient {
  private current?: Running;
  private readonly python: string | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env, private readonly options: WaylandPortalClientOptions = {}) {
    this.env = nativeEnvironment(env);
    // Desktop GI packages are normally installed for the distribution Python,
    // not a tool runner's virtual environment which happens to precede it in PATH.
    this.python = options.python ?? findExecutable(["/usr/bin/python3", "python3"], this.env);
  }

  private reference(run: Running, active: boolean): void {
    active ? run.child.ref() : run.child.unref();
    for (const stream of [run.child.stdin, run.child.stdout, run.child.stderr]) {
      const handle = stream as unknown as { ref?: () => void; unref?: () => void };
      active ? handle.ref?.() : handle.unref?.();
    }
  }

  private idle(run: Running): void {
    if (run.stopping || this.current !== run) return;
    this.reference(run, false);
    clearTimeout(run.idle);
    run.idle = setTimeout(() => { void this.stop(run, new ComputerError("portal_session_closed",
      "The idle Wayland permission session expired. Run computer_setup again.")); }, this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    run.idle.unref();
  }

  private stop(run: Running, error: ComputerError): Promise<void> {
    run.failure ??= error;
    if (run.stopping) return run.stopping;
    clearTimeout(run.idle);
    this.reference(run, true);
    // SIGTERM lets the helper release held input and close outstanding requests.
    // The promise remains pending until an actual process exit, even if kill emits an error.
    const kill = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        try { run.child.kill("SIGKILL"); } catch { /* do not invent an exit */ }
      }
    }, 1500);
    run.stopping = run.exited.finally(() => { clearTimeout(kill); });
    if (run.child.exitCode === null && run.child.signalCode === null) {
      try { run.child.kill("SIGTERM"); } catch { /* bounded escalation above */ }
    }
    return run.stopping;
  }

  private start(): Running {
    if (!this.python) throw new ComputerError("dependency_missing",
      "Install distribution Python 3, PyGObject, GStreamer and its PipeWire plugin for Wayland control.");
    const child = spawn(this.python, ["-I", "-u", "-c", this.options.source ?? waylandHelper], {
      env: this.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true
    });
    let exit!: () => void;
    const run: Running = { child, exited: new Promise<void>(resolve => { exit = resolve; }), pieces: [], bytes: 0, stderrBytes: 0 };
    this.current = run;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(run.idle);
      const pending = run.pending;
      run.pending = undefined;
      pending?.finish();
      pending?.reject(run.failure ?? new ComputerError("portal_session_closed",
        "The Wayland helper or desktop session closed. Run computer_setup again.",
        { mayHaveApplied: pending.operation === "act" }));
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (this.current === run) this.current = undefined;
      exit();
    };
    child.once("exit", finish);
    child.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (!child.pid) {
        run.failure = new ComputerError("native_spawn_failed", "Could not start the Wayland helper.",
          { cause: code ?? "unknown", mayHaveApplied: false });
        finish();
      } else void this.stop(run, new ComputerError("native_process_failed",
        "The Wayland helper reported a process error.", { mayHaveApplied: run.pending?.operation === "act" }));
    });
    child.stdin.on("error", () => {
      void this.stop(run, new ComputerError("portal_connection_lost",
        "The Wayland helper input channel closed.", { mayHaveApplied: run.pending?.operation === "act" }));
    });
    // Native diagnostics can contain desktop names or application text; never log them.
    child.stderr.on("data", (bytes: Buffer) => {
      run.stderrBytes += bytes.length;
      if (run.stderrBytes > 256 * 1024) void this.stop(run, new ComputerError("output_too_large",
        "The Wayland helper exceeded its diagnostic output limit.", { mayHaveApplied: run.pending?.operation === "act" }));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (run.stopping) return;
      const invalid = () => { void this.stop(run, new ComputerError("portal_invalid_response",
        "The Wayland helper returned an invalid or oversized response.", { mayHaveApplied: run.pending?.operation === "act" })); };
      run.bytes += chunk.length;
      if (run.bytes > OUTPUT_LIMIT || !run.pending) { invalid(); return; }
      const newline = chunk.indexOf(10);
      if (newline < 0) { run.pieces.push(chunk); return; }
      // There is only one in-flight request, and no unsolicited stdout protocol.
      if (newline !== chunk.length - 1) { invalid(); return; }
      run.pieces.push(chunk.subarray(0, newline));
      let message: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      try { message = JSON.parse(Buffer.concat(run.pieces).toString("utf8")) as typeof message; }
      catch { invalid(); return; }
      run.pieces = []; run.bytes = 0;
      const pending = run.pending;
      if (!message || message.id !== pending.id || typeof message.ok !== "boolean") { invalid(); return; }
      if (message.ok) {
        run.pending = undefined; pending.finish(); pending.resolve(message.result);
      } else {
        const failure = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          message: z.string().max(1024), details: z.record(z.string(), z.unknown()).optional() }).safeParse(message.error);
        if (!failure.success) { invalid(); return; }
        run.pending = undefined; pending.finish();
        pending.reject(new ComputerError(failure.data.code, failure.data.message,
          { ...failure.data.details, mayHaveApplied: pending.operation === "act" }));
      }
      this.idle(run);
    });
    return run;
  }

  async call(operation: Operation, args: Record<string, unknown>, context: NativeContext): Promise<unknown> {
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs < 1 || context.timeoutMs > 120000) {
      throw new ComputerError("invalid_timeout", "Wayland timeout must be 1–120000 ms.");
    }
    if (context.signal?.aborted) throw new ComputerError("cancelled", "Wayland operation was cancelled before execution.");
    if (this.current?.stopping) await this.current.stopping;
    if (context.signal?.aborted) throw new ComputerError("cancelled", "Wayland operation was cancelled before execution.");
    const run = this.current ?? this.start();
    if (run.pending) throw new ComputerError("computer_busy", "Another Wayland operation is in progress.");
    clearTimeout(run.idle);
    this.reference(run, true);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { void this.stop(run, new ComputerError("cancelled", "Wayland operation was cancelled.",
        { mayHaveApplied: operation === "act" })); };
      const timer = setTimeout(() => { void this.stop(run, new ComputerError("timeout",
        "Wayland operation exceeded its deadline; the permission session was closed.",
        { mayHaveApplied: operation === "act" })); }, context.timeoutMs);
      run.pending = { id, operation, resolve, reject,
        finish: () => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); } };
      context.signal?.addEventListener("abort", abort, { once: true });
      const request = JSON.stringify({ ...args, id, operation, timeoutMs: Math.ceil(context.timeoutMs) }) + "\n";
      if (Buffer.byteLength(request, "utf8") > 256 * 1024) {
        void this.stop(run, new ComputerError("invalid_arguments", "Wayland request exceeds its size limit."));
        return;
      }
      if (context.signal?.aborted) { abort(); return; }
      run.child.stdin.write(request);
    });
  }

  async close(): Promise<void> {
    const run = this.current;
    if (run) await this.stop(run, new ComputerError("portal_session_closed",
      "The Wayland permission session was closed. Run computer_setup again.",
      { mayHaveApplied: run.pending?.operation === "act" }));
  }
}

const dimension = z.number().int().min(1).max(32768);
const displaySchema = z.object({
  id: z.string().min(1).max(200), instanceId: z.string().min(1).max(200),
  x: z.number().finite(), y: z.number().finite(), width: dimension, height: dimension,
  scaleX: z.number().finite().positive(), scaleY: z.number().finite().positive(),
  rotation: z.number().finite().optional(), primary: z.boolean().optional(), name: z.string().max(256).optional()
}).refine(value => value.width * value.height <= 120000000);
const stateSchema = z.object({
  platform: z.literal("linux"), backend: z.literal("linux-wayland-portal"), available: z.boolean(),
  displayKind: z.enum(["physical", "virtual", "none", "unknown"]),
  inputKind: z.enum(["mouse_keyboard", "touch", "none"]), displays: z.array(displaySchema).max(8),
  actions: z.array(z.enum(["move", "click", "drag", "scroll", "key", "text"])).max(6), unicodeText: z.boolean(),
  permissions: z.record(z.string(), z.enum(["granted", "denied", "unknown", "not-needed"])),
  reason: z.string().max(2048).optional(), details: z.record(z.string(), z.unknown()).optional()
});

export function createWaylandBackend(env: NodeJS.ProcessEnv = process.env,
  options: WaylandPortalClientOptions = {}): ComputerBackend {
  const client = new WaylandPortalClient(env, options);
  async function state(value: unknown): Promise<ComputerState> {
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) {
      await client.close();
      throw new ComputerError("portal_invalid_response", "The Wayland helper returned invalid display capabilities.");
    }
    return parsed.data;
  }
  return {
    id: "linux-wayland-portal", setupInWorker: true,
    close: () => client.close(),
    async inspect(context, displayId) {
      return state(await client.call("inspect", { displayId }, context));
    },
    async setup(context) {
      const result = await client.call("setup", {}, context) as { state?: unknown } | null;
      return { state: await state(result?.state), automaticInstall: false,
        sessionLifetime: "Current relay connection, until pause, portal revocation, cancellation or five minutes of inactivity. Reconnect with computer_setup.",
        consent: "The desktop user selects monitors and approves pointer/keyboard access in the system portal." };
    },
    async screenshot(displayId, context) {
      const result = z.object({ data: z.string().max(Math.ceil(IMAGE_LIMIT / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
        mimeType: z.literal("image/png"), display: displaySchema, capturedAt: z.number().finite().positive()
      }).safeParse(await client.call("screenshot", { displayId }, context));
      if (!result.success) {
        await client.close();
        throw new ComputerError("portal_invalid_response", "The Wayland helper returned invalid screenshot data.");
      }
      const data = Buffer.from(result.data.data, "base64");
      try {
        const size = pngDimensions(data), display = result.data.display;
        if (data.length > IMAGE_LIMIT || size.width !== display.width || size.height !== display.height
          || result.data.capturedAt > Date.now() + 5000 || displayId !== undefined && displayId !== display.id) {
          throw new ComputerError("invalid_screenshot_geometry", "The Wayland screenshot does not match its selected display.");
        }
      } catch (error) { await client.close(); throw error; }
      return { ...result.data, data };
    },
    async act(action, display, context) {
      const result = await client.call("act", { action, display }, context);
      if (!result || typeof result !== "object" || !("submitted" in result) || result.submitted !== true) {
        await client.close();
        throw new ComputerError("portal_invalid_response", "The Wayland helper returned no valid input receipt.", { mayHaveApplied: true });
      }
      return result as Record<string, unknown>;
    }
  };
}
