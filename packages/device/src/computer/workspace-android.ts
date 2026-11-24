import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ANDROID_WORKSPACE_HELPER } from "./android-workspace.generated.js";
import { findExecutable, nativeEnvironment, pngDimensions, runNative } from "./native.js";
import { ComputerError, type ComputerAction, type ComputerDisplay, type ComputerState, type NativeContext } from "./types.js";
import type {
  WorkspaceCapabilities, WorkspaceOpenOptions, WorkspaceProvider, WorkspaceProviderContext,
  WorkspaceRecoveryResult, WorkspaceResource
} from "./workspace-types.js";

const ID = "android-private-display";
const MAIN = "dev.cyjin.mcprelay.workspace.WorkspaceMain";
const MAX_LEASE_MS = 900_000;
const MAX_HARD_MS = 86_400_000;
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const REQUIRED_FLAGS = (1 << 7) | (1 << 11) | (1 << 12);
const IDENTIFIER = /^[A-Za-z0-9_-]{8,100}$/;
const COMPONENT = /^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/;
const ACTIONS = ["click", "drag", "scroll", "key", "text"] as const;
type ObjectValue = Record<string, unknown>;

export interface AndroidWorkspaceRuntime {
  run?: typeof runNative;
  spawn?: typeof spawn;
  find?: typeof findExecutable;
  env?: NodeJS.ProcessEnv;
  home?: string;
  android?: boolean;
  now?: () => number;
  monotonic?: () => number;
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComputerError("android_workspace_protocol", "Invalid Android workspace response.");
  return value as ObjectValue;
}
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new ComputerError("invalid_workspace", "Invalid Android workspace owner identity.");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new ComputerError("invalid_workspace", "Invalid Android launch arguments.");
  return value as string[];
}
function helperError(error: unknown): ComputerError {
  return error instanceof ComputerError ? error : new ComputerError("android_workspace_failed", error instanceof Error ? error.message : String(error));
}

export function validateAndroidWorkspaceOptions(options: WorkspaceOpenOptions, now: number): void {
  identifier(options.leaseId);
  if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width < 64 || options.height < 64
    || options.width > 4096 || options.height > 4096 || options.width * options.height > 4_194_304) {
    throw new ComputerError("invalid_workspace", "Android workspaces require 64–4096 pixels per axis and at most four megapixels.");
  }
  if (options.windowIds?.length) throw new ComputerError("workspace_adoption_unsupported", "Android private workspaces cannot adopt an existing application task.");
  if (options.launch) {
    if (!COMPONENT.test(options.launch.executable) || strings(options.launch.args).length) {
      throw new ComputerError("invalid_workspace_launch", "Use an explicit Android package/Activity component without extra intent arguments.");
    }
  }
  const ttl = options.expiresAt - now, hardTtl = options.hardExpiresAt - now;
  if (!Number.isFinite(ttl) || !Number.isFinite(hardTtl) || ttl < 1 || ttl > MAX_LEASE_MS
    || hardTtl < ttl || hardTtl > MAX_HARD_MS) throw new ComputerError("invalid_workspace_expiry", "Invalid Android workspace lease or hard deadline.");
}

function display(value: unknown, expectedName: string): ComputerDisplay {
  const source = object(value);
  if (!Number.isInteger(source.id) || (source.id as number) <= 0 || typeof source.uniqueId !== "string"
    || source.name !== expectedName || !Number.isInteger(source.width) || !Number.isInteger(source.height)
    || (source.width as number) < 64 || (source.height as number) < 64
    || source.removeMode !== 0 || !Number.isInteger(source.flags) || ((source.flags as number) & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
    throw new ComputerError("workspace_isolation_unavailable", "Android did not retain this workspace's display identity and independent-focus flags.");
  }
  return { id: "android-workspace:" + source.id, instanceId: source.uniqueId, x: 0, y: 0,
    width: source.width as number, height: source.height as number, scaleX: 1, scaleY: 1, rotation: 0,
    primary: false, name: expectedName };
}
function sameDisplay(actual: ComputerDisplay, expected: ComputerDisplay): void {
  if (actual.id !== expected.id || actual.instanceId !== expected.instanceId || actual.width !== expected.width || actual.height !== expected.height) {
    throw new ComputerError("workspace_identity_changed", "The Android workspace display changed or was replaced.");
  }
}

async function bounded<T>(promise: Promise<T>, context: NativeContext, onStop: () => Promise<void>): Promise<T> {
  if (!Number.isFinite(context.timeoutMs) || context.timeoutMs < 1 || context.timeoutMs > 120_000) {
    throw new ComputerError("invalid_timeout", "Android workspace timeout must be 1–120000 ms.");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const clear = () => { clearTimeout(timer); context.signal?.removeEventListener("abort", cancelled); };
    const stop = (error: ComputerError) => {
      if (settled) return;
      settled = true; clear();
      // Revocation/EOF precedes returning a cancelled or timed-out input call.
      void onStop().then(() => reject(error), () => reject(error));
    };
    const cancelled = () => stop(new ComputerError("cancelled", "Android workspace operation was cancelled.", { mayHaveApplied: true }));
    const timer = setTimeout(() => stop(new ComputerError("timeout", "Android workspace operation exceeded its deadline.", { mayHaveApplied: true })), context.timeoutMs);
    context.signal?.addEventListener("abort", cancelled, { once: true });
    promise.then(value => { if (!settled) { settled = true; clear(); resolve(value); } },
      error => { if (!settled) { settled = true; clear(); reject(error); } });
    if (context.signal?.aborted) cancelled();
  });
}

class AndroidOwner {
  readonly ready: Promise<ObjectValue>;
  readonly exited: Promise<void>;
  private resolveReady!: (value: ObjectValue) => void;
  private rejectReady!: (error: unknown) => void;
  private resolveExit!: () => void;
  private pending = new Map<string, { resolve(value: ObjectValue): void; reject(error: unknown): void }>();
  private buffer = "";
  private sequence = 0;
  private hasExited = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  closeReceipt?: ObjectValue;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Native exit can happen before a caller attaches its ready waiter.
    void this.ready.catch(() => {});
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
        this.fail(new ComputerError("output_too_large", "Android workspace output exceeded its limit."));
        void this.stop(); return;
      }
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = object(JSON.parse(line));
          if (message.event === "ready") this.resolveReady(message);
          else if (message.event === "closed") { this.closeReceipt = message; this.rejectPending(new ComputerError("workspace_closed", "Android workspace input has been revoked.")); }
          else if (typeof message.id === "string") {
            const request = this.pending.get(message.id);
            if (message.ok === true) request?.resolve(object(message.result));
            else {
              const error = new ComputerError("android_workspace_native", typeof message.error === "string" ? message.error.slice(0, 4096) : "Android workspace helper rejected the request.");
              if (message.id === "startup") this.rejectReady(error);
              request?.reject(error);
            }
          }
        } catch (error) { this.fail(helperError(error)); void this.stop(); }
      }
    });
    // Drain native diagnostics without returning unrelated Android service logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", error => { this.fail(helperError(error)); });
    child.on("error", error => { this.fail(helperError(error)); if (!child.pid) this.onExit(); });
    child.once("exit", () => this.onExit());
  }
  private rejectPending(error: unknown): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  private fail(error: unknown): void { this.rejectReady(error); this.rejectPending(error); }
  private onExit(): void {
    if (this.hasExited) return;
    this.hasExited = true; this.resolveExit();
    this.fail(new ComputerError("workspace_closed", "The Android workspace owner exited."));
  }
  async request(op: string, args: ObjectValue, context: NativeContext): Promise<ObjectValue> {
    if (this.hasExited || this.stopping) throw new ComputerError("workspace_closed", "The Android workspace is closing.");
    const id = "request_" + ++this.sequence;
    const result = new Promise<ObjectValue>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    try { return await bounded(result, context, () => this.stop()); }
    finally { this.pending.delete(id); }
  }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      if (this.hasExited) return;
      try { this.child.stdin.end(JSON.stringify({ id: "closing", op: "close" }) + "\n"); } catch { /* EOF and watchdog remain authoritative */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 12_000); })]); }
      finally { clearTimeout(timer); }
    })();
    return this.stopPromise;
  }
}

interface Session {
  owner: AndroidOwner;
  resource: WorkspaceResource;
  expiresAt: number;
  deadline: number;
  hardDeadline: number;
}

export function createAndroidWorkspaceProvider(runtime: AndroidWorkspaceRuntime = {}): WorkspaceProvider {
  const run = runtime.run ?? runNative, start = runtime.spawn ?? spawn, find = runtime.find ?? findExecutable;
  const env = runtime.env ?? process.env;
  const now = runtime.now ?? Date.now, monotonic = runtime.monotonic ?? (() => performance.now());
  const sessions = new Map<string, Session>();
  let artifact: Promise<string> | undefined;
  const command = (jar: string, args: string[] = []) => "CLASSPATH=" + quote(jar) + " /system/bin/app_process / " + MAIN
    + args.map(value => " " + quote(value)).join("");
  const su = () => {
    const path = find(["su", "/system/xbin/su", "/system/bin/su"], env);
    if (!path) throw new ComputerError("workspace_isolation_unavailable", "Root su is required for Android's trusted independent-focus display.");
    return path;
  };
  const isAndroid = () => runtime.android ?? (process.platform === "android" || Boolean(find(["/system/bin/app_process"], env)));
  async function ensureArtifact(install = false): Promise<string> {
    if (!artifact) artifact = (async () => {
      const directory = join(runtime.home ?? homedir(), ".mcp-relay", "native", "android-workspace");
      if (install) await mkdir(directory, { recursive: true, mode: 0o700 });
      const status = await lstat(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ComputerError("workspace_setup_required", "Run computer_setup with workspace:true to deploy the bundled Android workspace helper.");
        throw error;
      });
      if (!status.isDirectory() || status.isSymbolicLink()) throw new ComputerError("unsafe_workspace_path", "Android helper cache is not a private directory.");
      if (install) await chmod(directory, 0o700);
      const bytes = Buffer.from(ANDROID_WORKSPACE_HELPER.base64, "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== ANDROID_WORKSPACE_HELPER.sha256) throw new ComputerError("invalid_workspace_helper", "Bundled Android helper failed its integrity check.");
      const path = join(directory, "workspace-" + digest + ".jar");
      if (!install) {
        const existing = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ComputerError("workspace_setup_required", "Run computer_setup with workspace:true to deploy the bundled Android workspace helper.");
          throw error;
        });
        if (!existing.isFile() || existing.isSymbolicLink() || createHash("sha256").update(await readFile(path)).digest("hex") !== digest) {
          throw new ComputerError("invalid_workspace_helper", "Cached Android helper does not match the bundled artifact.");
        }
        return path;
      }
      try {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink() || createHash("sha256").update(await readFile(path)).digest("hex") !== digest) {
          throw new ComputerError("invalid_workspace_helper", "Cached Android helper does not match the bundled artifact.");
        }
      }
      return path;
    })().catch(error => { artifact = undefined; throw error; });
    return artifact;
  }
  async function native(args: string[], context: NativeContext): Promise<ObjectValue> {
    const jar = await ensureArtifact();
    const result = await run({ command: su(), args: ["-c", command(jar, args)], env, maxOutputBytes: 128 * 1024 }, context);
    const lines = result.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
    if (result.exitCode !== 0 || !lines.length) throw new ComputerError("android_workspace_native", "Android root workspace helper is unavailable.");
    const response = object(JSON.parse(lines.at(-1)!));
    if (response.ok === false) throw new ComputerError("android_workspace_native", String(response.error).slice(0, 4096));
    return response;
  }
  const unavailable = (reason: string): WorkspaceCapabilities => ({
    available: false, reason, isolated: false, canAdoptWindows: false, recovery: "unsupported",
    independentWatchdog: false, unicodeText: false, clipboardBoundary: "shared-app-state"
  });
  function session(resource: WorkspaceResource): Session {
    if (resource.providerId !== ID) throw new ComputerError("workspace_identity_changed", "Android workspace provider identity does not match.");
    const active = sessions.get(identifier(resource.instanceId));
    if (!active || active.resource.leaseId !== resource.leaseId) throw new ComputerError("workspace_closed", "Android workspace no longer has a live owner; recovery is required.");
    sameDisplay(active.resource.display, resource.display);
    return active;
  }
  function receiptPath(instanceId: string, context: WorkspaceProviderContext): string {
    const directory = resolve(context.journalDirectory);
    return join(directory, "android-" + identifier(instanceId) + ".json");
  }
  async function ownedReceipt(path: string, leaseId: string, instanceId: string): Promise<boolean> {
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.size > 64 * 1024) throw new ComputerError("unsafe_workspace_receipt", "Android recovery receipt is not a bounded regular file.");
      const value = object(JSON.parse(await readFile(path, "utf8")));
      if (value.leaseId !== leaseId || value.instanceId !== instanceId || value.displayName !== "mcp-relay-workspace:" + leaseId + ":" + instanceId
        || basename(path) !== "android-" + instanceId + ".json") throw new ComputerError("workspace_identity_changed", "Android recovery receipt belongs to a different owner.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  return {
    id: ID,
    async setup(context) {
      if (!isAndroid()) throw new ComputerError("workspace_isolation_unavailable", "Android workspace setup requires a native Android 14+ device.");
      su();
      await ensureArtifact(true);
      const verified = await native(["--probe"], context);
      if (verified.available !== true || verified.root !== true || Number(verified.sdk) < 34) throw new ComputerError("workspace_isolation_unavailable", "Android trusted independent-focus display support is unavailable.");
      return { installed: true, helperSha256: ANDROID_WORKSPACE_HELPER.sha256, sdk: verified.sdk,
        independentWatchdog: true, globalImeChanged: false, clipboardBoundary: "shared-app-state" };
    },
    async probe(context) {
      if (!isAndroid()) return unavailable("Android private displays require a native Android 14+ device with root.");
      try {
        const result = await native(["--probe"], context);
        if (result.available !== true || result.root !== true || Number(result.sdk) < 34) return unavailable("Android 14+ trusted display support is unavailable.");
        return {
          available: true, isolated: true, canAdoptWindows: false, recovery: "window-moved",
          independentWatchdog: true, unicodeText: false, clipboardBoundary: "shared-app-state",
          details: {
            minimumAndroidSdk: 34, sdk: result.sdk, rootRequired: true,
            independentFocusFlagsVerifiedOnOpen: true, inputDisplayScoped: true, imePolicy: "hidden",
            text: "ASCII keyboard characters only; global IME and clipboard operations are unavailable.",
            clipboard: "Applications share the Android user's clipboard and app state. This is input/focus isolation, not an application security sandbox.",
            launch: "Explicit package/Activity component; refuses an application that already has a task on another display.",
            cleanup: "Moves owned-display tasks to display 0 before release. Android may recreate an activity during migration.",
            watchdog: "Independent monotonic lease, fixed hard deadline, 15-second owner heartbeat, EOF and binder death."
          }
        };
      } catch (error) { return unavailable(helperError(error).message); }
    },

    async open(options, context) {
      validateAndroidWorkspaceOptions(options, now());
      if (!isAndroid()) throw new ComputerError("workspace_isolation_unavailable", "Android private displays require Android 14+ with root.");
      if (context.signal?.aborted) throw new ComputerError("cancelled", "Workspace creation was cancelled.");
      if (!isAbsolute(context.journalDirectory)) throw new ComputerError("unsafe_workspace_path", "Android workspace journal must use an absolute private directory.");
      const jar = await ensureArtifact();
      const instanceId = randomUUID();
      const displayName = "mcp-relay-workspace:" + options.leaseId + ":" + instanceId;
      const path = receiptPath(instanceId, context);
      if (resolve(context.revocationPath) !== join(resolve(context.journalDirectory), "revoked.json")) throw new ComputerError("unsafe_workspace_path", "Android workspace revocation fence must be in the private lease directory.");
      const pending: WorkspaceResource = {
        providerId: ID, leaseId: options.leaseId, instanceId,
        display: { id: "android-workspace:pending", instanceId, x: 0, y: 0, width: options.width, height: options.height, primary: false, name: displayName },
        data: { version: 1, phase: "intent", receipt: path, displayName, revocationPath: context.revocationPath, helperSha256: ANDROID_WORKSPACE_HELPER.sha256 }
      };
      // Durable intent exists before any privileged display owner can be started.
      await context.checkpoint(pending);
      await mkdir(context.journalDirectory, { recursive: true, mode: 0o700 });
      const directory = await lstat(context.journalDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ComputerError("unsafe_workspace_path", "Android workspace journal is not a private directory.");
      await chmod(context.journalDirectory, 0o700);
      const remaining = options.expiresAt - now(), hardRemaining = options.hardExpiresAt - now();
      if (remaining < 1 || hardRemaining < remaining) throw new ComputerError("workspace_expired", "Workspace authorization expired before display creation.");
      const child = start(su(), ["-c", command(jar, ["--owner", options.leaseId, instanceId])], {
        stdio: ["pipe", "pipe", "pipe"], env: nativeEnvironment(env), windowsHide: true, shell: false
      }) as ChildProcessWithoutNullStreams;
      const owner = new AndroidOwner(child);
      const active: Session = { owner, resource: pending, expiresAt: options.expiresAt, deadline: monotonic() + remaining, hardDeadline: monotonic() + hardRemaining };
      sessions.set(instanceId, active);
      child.stdin.write(JSON.stringify({ leaseId: options.leaseId, instanceId, width: options.width, height: options.height,
        ttlMs: Math.floor(remaining), hardTtlMs: Math.floor(hardRemaining), receipt: path, revocationPath: context.revocationPath }) + "\n");
      try {
        const ready = await bounded(owner.ready, context, () => owner.stop());
        if (ready.leaseId !== options.leaseId || ready.instanceId !== instanceId || ready.imePolicy !== 2) throw new ComputerError("workspace_identity_changed", "Android workspace owner identity or IME policy does not match.");
        const value = display(ready.display, displayName);
        if (value.width !== options.width || value.height !== options.height) throw new ComputerError("workspace_identity_changed", "Android workspace dimensions do not match.");
        const resource: WorkspaceResource = { ...pending, display: value, data: { ...pending.data, phase: "active", pid: Number(ready.pid), nativeDisplayId: object(ready.display).id as number } };
        active.resource = resource;
        await context.checkpoint(resource);
        if (options.launch) {
          await context.checkpoint(resource);
          await owner.request("launch", { component: options.launch.executable }, context);
        }
        return resource;
      } catch (error) { await owner.stop(); throw error; }
    },

    async renew(resource, expiresAt, context) {
      const active = session(resource);
      const clock = monotonic();
      if (expiresAt !== active.expiresAt) {
        const remaining = expiresAt - now();
        if (!Number.isFinite(remaining) || remaining < 1 || remaining > MAX_LEASE_MS) throw new ComputerError("invalid_workspace_expiry", "Invalid Android workspace renewal.");
        active.expiresAt = expiresAt;
        active.deadline = Math.min(active.hardDeadline, clock + remaining);
      }
      const ttlMs = Math.floor(Math.min(active.deadline, active.hardDeadline) - clock);
      if (ttlMs < 1) { await active.owner.stop(); throw new ComputerError("workspace_expired", "Android workspace lease has expired."); }
      await context.checkpoint(resource);
      await active.owner.request("renew", { ttlMs }, context);
    },

    async inspect(resource, context) {
      const active = session(resource), value = await active.owner.request("inspect", {}, context);
      const actual = display(value.display, String(resource.data.displayName));
      sameDisplay(actual, resource.display);
      if (value.imePolicy !== 2 || value.inputAllowed !== true) throw new ComputerError("workspace_isolation_unavailable", "Android workspace lost its isolated input policy.");
      const appId = typeof value.appId === "string" && value.appId ? value.appId : undefined;
      const state: ComputerState = {
        platform: "android", backend: ID, available: true, displayKind: "virtual", inputKind: "touch",
        displays: [actual], actions: [...ACTIONS], unicodeText: false,
        permissions: { root: "granted", display: "granted", input: "granted", clipboard: "not-needed", ime: "not-needed" },
        ...(appId ? { app: { id: appId } } : {}),
        details: { remainingMs: value.remainingMs, clipboardBoundary: "shared-app-state", imePolicy: "hidden", independentFocus: true }
      };
      return state;
    },

    async capture(resource, context) {
      const active = session(resource), result = await active.owner.request("capture", {}, context);
      if (result.displayId !== resource.data.nativeDisplayId || result.width !== resource.display.width || result.height !== resource.display.height
        || typeof result.base64 !== "string" || result.base64.length > MAX_MESSAGE_BYTES) throw new ComputerError("workspace_identity_changed", "Android capture does not belong to this workspace.");
      const data = Buffer.from(result.base64, "base64"), size = pngDimensions(data);
      if (size.width !== resource.display.width || size.height !== resource.display.height) throw new ComputerError("workspace_identity_changed", "Android capture dimensions changed.");
      const appId = typeof result.appId === "string" && result.appId ? result.appId : undefined;
      return { data, mimeType: "image/png" as const, display: resource.display, capturedAt: now(), ...(appId ? { app: { id: appId } } : {}) };
    },

    async act(resource, action: ComputerAction, context) {
      const active = session(resource);
      if (action.type === "move") throw new ComputerError("unsupported_action", "Android private workspaces use display-scoped touch input and do not move a shared pointer.");
      if (action.type === "text" && !/^[\x20-\x7e\r\n\t]{0,4096}$/.test(action.text)) {
        throw new ComputerError("unicode_text_unsupported", "Android private workspace text currently supports ASCII keyboard characters only.");
      }
      return active.owner.request("act", { action, ...(context.expectedAppId ? { expectedAppId: context.expectedAppId } : {}) }, context);
    },

    async recover(resource, options, reason, context): Promise<WorkspaceRecoveryResult> {
      identifier(options.leaseId);
      if (resource && (resource.providerId !== ID || resource.leaseId !== options.leaseId)) throw new ComputerError("workspace_identity_changed", "Cannot recover a different Android workspace owner.");
      const instances = new Set<string>();
      if (resource) instances.add(identifier(resource.instanceId));
      for (const [instanceId, active] of sessions) if (active.resource.leaseId === options.leaseId) instances.add(instanceId);
      // A crash between the durable intent and open's return can leave only this lease's private receipt.
      if (!resource) {
        for (const name of await readdir(context.journalDirectory).catch(() => [] as string[])) {
          const match = /^android-([A-Za-z0-9_-]{8,100})\.json$/.exec(name);
          if (!match) continue;
          try {
            const value = object(JSON.parse(await readFile(join(context.journalDirectory, name), "utf8")));
            if (value.leaseId === options.leaseId) instances.add(identifier(match[1]));
          } catch { /* Never infer ownership from a malformed or unrelated receipt. */ }
        }
      }
      if (!instances.size) return { complete: true, outcome: "no-resources", inputRevoked: true, ownedDisplayRemoved: true };
      const reports: ObjectValue[] = [];
      let complete = true, inputRevoked = true, ownedDisplayRemoved = true;
      for (const instanceId of instances) {
        const active = sessions.get(instanceId);
        if (resource) await context.checkpoint({ ...resource, data: { ...resource.data, phase: "restoring", reason } });
        if (active) await active.owner.stop();
        const path = receiptPath(instanceId, context);
        let revoked = false, removed = false;
        try {
          // Recovery deliberately survives cancellation of the action that requested it.
          const recoveryContext: NativeContext = { timeoutMs: Math.min(30_000, Math.max(15_000, context.timeoutMs)) };
          if (await ownedReceipt(path, options.leaseId, instanceId)) {
            const result = await native(["--recover", path], recoveryContext);
            revoked = result.inputRevoked === true;
            removed = result.ownedDisplayRemoved === true;
            reports.push(result);
          } else {
            const found = await native(["--find", "mcp-relay-workspace:" + options.leaseId + ":" + instanceId], recoveryContext);
            removed = Array.isArray(found.displays) && found.displays.length === 0;
            // No receipt is possible before a display is created. Waiting for this owner to exit establishes revocation.
            revoked = removed && !active;
            if (active) revoked = removed && active.owner.child.exitCode !== null;
          }
        } catch (error) { reports.push({ error: helperError(error).message, instanceId }); }
        complete &&= revoked && removed; inputRevoked &&= revoked; ownedDisplayRemoved &&= removed;
        if (revoked && removed) sessions.delete(instanceId);
      }
      return { complete, outcome: complete ? "window-moved" : "cleanup-pending", inputRevoked, ownedDisplayRemoved,
        details: { reason, reports, applicationsMayRecreateOnDisplayMigration: true } };
    }
  };
}
