import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_POLL_MS = 5 * 60 * 1000;
const FAILED_COOLDOWN_MS = 60 * 60 * 1000;

export interface UpdateManifest {
  schemaVersion: 1;
  version: string;
  url: string;
  sha256: string;
  minNodeVersion?: string;
}
export interface SupervisorOptions {
  /** A self-contained published .cjs bundle, not a tsx development entry. */
  entryPoint: string;
  version: string;
  /** Reusable connect arguments: no one-time pairing code. */
  args: string[];
  relayUrl: string;
  stateDir: string;
  manifestUrl?: string;
  pollIntervalMs?: number;
  drainTimeoutMs?: number;
  readyTimeoutMs?: number;
  stabilityMs?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
}
export interface SupervisorRuntime {
  fetch?: typeof globalThis.fetch;
}
export interface Release {
  version: string;
  sha256: string;
  entryPoint: string;
}
interface FailedRelease {
  version: string;
  sha256: string;
  retryAfter: number;
  reason: string;
}
interface WorkerReloadRequest {
  id: string;
  requestedAt: number;
  /** Identity of the desired settings revision; never contains settings or credentials. */
  requestKey?: string;
}
interface WorkerReloadState extends WorkerReloadRequest {
  status: "pending" | "deferred" | "completed" | "failed";
  updatedAt: number;
  reason?: string;
}
interface UpdateState {
  schemaVersion: 1;
  phase: string;
  current: Release;
  previous?: Release;
  supervisorVersion?: string;
  handoff?: { candidate: Release; from: Release; startedAt: number };
  pending?: { candidate: Release; from: Release; startedAt: number };
  failed?: FailedRelease;
  checkedAt?: number;
  updatedAt: number;
  lastResult?: { status: string; version?: string; reason?: string };
  reload?: WorkerReloadState;
}
export type SupervisorMessage =
  | { type: "relay:drain"; requestId: string }
  | { type: "relay:resume"; requestId: string }
  | { type: "relay:shutdown" };
export type WorkerMessage =
  | { type: "relay:ready"; version: string; slug?: string }
  | { type: "relay:drained"; requestId: string }
  | { type: "relay:drain-deferred"; requestId: string; reason: string };

function digest(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function versionParts(version: string): { core: number[]; pre: string[] } {
  if (typeof version !== "string" || version.length > 128) throw new Error("invalid release version");
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error("invalid release version");
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) throw new Error("invalid release version");
  return { core, pre: match[4]?.split(".") ?? [] };
}

/** Semver precedence, including numeric prerelease identifiers; build metadata is ignored. */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^[0-9]+$/.test(x), ny = /^[0-9]+$/.test(y);
    if (nx && ny) {
      const bx = BigInt(x), by = BigInt(y);
      if (bx !== by) return bx < by ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else return x < y ? -1 : 1;
  }
  return 0;
}

function trustedUrl(input: string, base?: URL): URL {
  const url = new URL(input, base);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("update URLs must use HTTPS without user information or fragments");
  }
  if (base && url.origin !== base.origin) throw new Error("update download must remain on the manifest origin");
  return url;
}

export function resolveManifestUrl(relayUrl: string, explicit?: string): string {
  return trustedUrl(explicit ?? new URL("/updates/device/stable.json", relayUrl).href).href;
}

export function validateUpdateManifest(value: unknown, source: string, nodeVersion = process.versions.node): UpdateManifest {
  if (!value || typeof value !== "object") throw new Error("invalid update manifest");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.version !== "string" || typeof item.url !== "string"
      || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
    throw new Error("invalid update manifest");
  }
  versionParts(item.version);
  if (item.minNodeVersion !== undefined) {
    if (typeof item.minNodeVersion !== "string") throw new Error("invalid minimum Node version");
    if (compareVersions(nodeVersion, item.minNodeVersion) < 0) throw new Error("candidate requires a newer Node runtime");
  }
  const url = trustedUrl(item.url, trustedUrl(source)).href;
  return {
    schemaVersion: 1, version: item.version, url, sha256: item.sha256.toLowerCase(),
    ...(typeof item.minNodeVersion === "string" ? { minNodeVersion: item.minNodeVersion } : {})
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Windows antivirus/indexing may briefly hold the destination. Never unlink it first.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

function readRelease(value: unknown): Release {
  if (!value || typeof value !== "object") throw new Error("invalid saved release");
  const release = value as Record<string, unknown>;
  if (typeof release.version !== "string" || typeof release.entryPoint !== "string"
      || !isAbsolute(release.entryPoint) || typeof release.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error("invalid saved release");
  versionParts(release.version);
  return { version: release.version, entryPoint: release.entryPoint, sha256: release.sha256 };
}

function validRelease(release: Release): boolean {
  try { return digest(readFileSync(release.entryPoint)) === release.sha256; }
  catch { return false; }
}

/** Public diagnostic view: never expose argv, config/token contents or filesystem paths. */
export function readUpdateStatus(stateDir: string): Record<string, unknown> {
  const requestedReload = readReloadRequest(stateDir);
  try {
    const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as UpdateState;
    if (state.schemaVersion !== 1) throw new Error("unknown update state");
    return {
      initialized: true, phase: state.phase, version: state.current?.version, supervisorVersion: state.supervisorVersion,
      sha256: state.current?.sha256, previousVersion: state.previous?.version,
      pendingVersion: state.pending?.candidate.version ?? state.handoff?.candidate.version, checkedAt: state.checkedAt,
      updatedAt: state.updatedAt, lastResult: state.lastResult,
      reload: requestedReload && state.reload?.id !== requestedReload.id ? { ...requestedReload, status: "pending" } : state.reload,
      failed: state.failed ? { version: state.failed.version, retryAfter: state.failed.retryAfter, reason: state.failed.reason } : undefined
    };
  } catch (error) {
    return { initialized: false, phase: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-started" : "state-unreadable",
      reload: requestedReload ? { ...requestedReload, status: "pending" } : undefined };
  }
}

/** A local, idempotent wake-up request. The supervisor observes it within one second. */
export async function requestUpdateCheck(stateDir: string): Promise<void> {
  await atomicJson(join(stateDir, "check-request.json"), { id: randomUUID(), requestedAt: Date.now() });
}

/** Coalesce only an outstanding request for the same desired settings revision. */
export async function requestWorkerReload(stateDir: string, requestKey?: string): Promise<void> {
  if (requestKey !== undefined && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestKey)) {
    throw new Error("invalid worker reload request key");
  }
  const pending = readReloadRequest(stateDir);
  if (pending && pending.requestKey === requestKey) {
    try {
      const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as UpdateState;
      if (state.reload?.id !== pending.id || !["completed", "failed"].includes(state.reload.status)) return;
    } catch { return; }
  }
  await atomicJson(join(stateDir, "reload-request.json"), {
    id: randomUUID(), requestedAt: Date.now(), ...(requestKey !== undefined ? { requestKey } : {})
  });
}

function readReloadRequest(stateDir: string): WorkerReloadRequest | undefined {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, "reload-request.json"), "utf8")) as Record<string, unknown>;
    if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)
      || typeof value.requestedAt !== "number" || !Number.isFinite(value.requestedAt)
      || (value.requestKey !== undefined && (typeof value.requestKey !== "string"
        || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.requestKey)))) return undefined;
    return { id: value.id, requestedAt: value.requestedAt,
      ...(typeof value.requestKey === "string" ? { requestKey: value.requestKey } : {}) };
  } catch { return undefined; }
}

function checkRequest(stateDir: string): string {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, "check-request.json"), "utf8")) as Record<string, unknown>;
    return typeof value.id === "string" ? value.id : "";
  } catch { return ""; }
}

/**
 * Kernel-owned locks disappear after crashes. Linux/Android abstract sockets and
 * Windows named pipes avoid stale PID files and require no compatibility symlinks.
 */
export async function acquireUpdateLock(stateDir: string, scope = "supervisor"): Promise<() => Promise<void>> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(stateDir);
  const key = digest((process.platform === "win32" ? canonical.toLowerCase() : canonical) + ":" + scope).slice(0, 40);
  const server = createServer((socket) => socket.destroy());
  const listener = process.platform === "win32"
    ? { path: "\\\\.\\pipe\\mcp-relay-update-" + key, exclusive: true }
    : process.platform === "linux" || process.platform === "android"
      ? { path: "\0mcp-relay-update-" + key, exclusive: true }
      : { host: "127.0.0.1", port: 40000 + parseInt(key.slice(0, 8), 16) % 20000, exclusive: true };
  await new Promise<void>((resolveLock, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") { reject(error); return; }
      const busy = new Error("another relay process already owns this update state") as NodeJS.ErrnoException;
      busy.code = "UPDATE_LOCK_BUSY";
      reject(busy);
    });
    server.listen(listener, () => resolveLock());
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((done) => server.close(() => done()));
  };
}

async function getBytes(source: string, limit: number, signal: AbortSignal, fetcher: typeof globalThis.fetch): Promise<Uint8Array> {
  let url = trustedUrl(source);
  const origin = new URL(url.origin);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { signal: requestSignal, redirect: "manual", credentials: "omit" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("invalid or excessive update redirects");
      url = trustedUrl(new URL(location, url).href, origin);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("update server returned HTTP " + response.status);
    }
    if (response.url) trustedUrl(response.url, origin);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel();
      throw new Error("update response exceeds size limit");
    }
    if (!response.body) throw new Error("empty update response");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error("update response exceeds size limit");
        parts.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(parts, size);
  }
  throw new Error("invalid update redirects");
}

async function preflight(entryPoint: string, version: string, signal: AbortSignal): Promise<void> {
  const options = { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, signal, cwd: dirname(entryPoint) };
  try { await executeFile(process.execPath, ["--check", entryPoint], options); }
  catch { throw new Error("candidate syntax check failed"); }
  let output: string;
  try {
    const result = await executeFile(process.execPath, [entryPoint, "--version"], { ...options, encoding: "utf8" });
    output = result.stdout.trim();
  } catch { throw new Error("candidate version/import check failed"); }
  if (output !== version) throw new Error("candidate version does not match manifest");
}

async function stageBundle(manifest: UpdateManifest, stateDir: string, signal: AbortSignal, fetcher: typeof globalThis.fetch): Promise<Release> {
  const release: Release = { version: manifest.version, sha256: manifest.sha256, entryPoint: join(stateDir, "releases", manifest.sha256, "cli.cjs") };
  if (existsSync(release.entryPoint)) {
    if (!validRelease(release)) throw new Error("cached candidate digest mismatch");
    await preflight(release.entryPoint, release.version, signal);
    return release;
  }
  const bytes = await getBytes(manifest.url, MAX_BUNDLE_BYTES, signal, fetcher);
  if (digest(bytes) !== manifest.sha256) throw new Error("candidate SHA-256 mismatch");
  mkdirSync(dirname(release.entryPoint), { recursive: true, mode: 0o700 });
  const staged = join(dirname(release.entryPoint), "staged-" + randomUUID() + ".cjs");
  writeFileSync(staged, bytes, { flag: "wx", mode: 0o600 });
  await preflight(staged, release.version, signal);
  renameSync(staged, release.entryPoint);
  return release;
}

interface Worker {
  child: ChildProcess;
  release: Release;
  ready: boolean;
  exited: boolean;
  startedAt: number;
  activationRequestId?: string;
  readyPromise: Promise<boolean>;
  exitPromise: Promise<void>;
  drains: Map<string, (ready: boolean) => void>;
  drainReasons: Map<string, string>;
}

function launchWorker(release: Release, args: string[], paused: boolean): Worker {
  const ready = Promise.withResolvers<boolean>();
  const exited = Promise.withResolvers<void>();
  const child = fork(release.entryPoint, args, {
    execArgv: [], windowsHide: true, stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, MCP_RELAY_WORKER: "1", MCP_RELAY_START_DRAINED: paused ? "1" : "0" }
  });
  const worker: Worker = {
    child, release, ready: false, exited: false, startedAt: Date.now(), readyPromise: ready.promise,
    exitPromise: exited.promise, drains: new Map(), drainReasons: new Map()
  };
  const finish = () => {
    worker.exited = true;
    ready.resolve(false);
    for (const resolveDrain of worker.drains.values()) resolveDrain(false);
    worker.drains.clear();
    exited.resolve();
  };
  child.once("exit", finish);
  child.once("error", () => { if (!child.pid) finish(); });
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.type === "relay:ready" && message.version === release.version) {
      worker.ready = true;
      ready.resolve(true);
    } else if (message.type === "relay:drain-deferred" && typeof message.requestId === "string" && worker.drains.has(message.requestId)) {
      worker.drainReasons.set(message.requestId, typeof message.reason === "string" ? safeReason(new Error(message.reason)) : "worker state requires an explicit reset before updating");
      worker.drains.get(message.requestId)?.(false);
      worker.drains.delete(message.requestId);
    } else if (message.type === "relay:drained" && typeof message.requestId === "string") {
      worker.drains.get(message.requestId)?.(true);
      worker.drains.delete(message.requestId);
    }
  });
  return worker;
}

function sendParent(message: Record<string, unknown>): Promise<boolean> {
  if (!process.connected || typeof process.send !== "function") return Promise.resolve(false);
  return new Promise((done) => {
    try { process.send!(message, (error: Error | null) => done(!error)); }
    catch { done(false); }
  });
}

function send(worker: Worker, message: SupervisorMessage): Promise<boolean> {
  if (!worker.child.connected || worker.exited) return Promise.resolve(false);
  return new Promise((done) => {
    try { worker.child.send(message, (error) => done(!error)); }
    catch { done(false); }
  });
}

async function waitFor<T>(promise: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  return new Promise((done) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(finish, abort);
  });
}

async function stopWorker(worker: Worker): Promise<void> {
  if (worker.exited) return;
  await waitFor(send(worker, { type: "relay:shutdown" }), 1_000);
  await waitFor(worker.exitPromise, 3_000);
  if (!worker.exited) {
    worker.child.kill("SIGTERM");
    await waitFor(worker.exitPromise, 2_000);
  }
  if (!worker.exited) {
    worker.child.kill("SIGKILL");
    await waitFor(worker.exitPromise, 2_000);
  }
  if (!worker.exited) throw new Error("previous relay worker could not be stopped");
}

function safeReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return "update operation failed (" + code + ")";
  return (error instanceof Error ? error.message : "update failed").replace(/https?:\/\/[^\s]+/g, "[update URL]").slice(0, 240);
}

async function initializeState(options: SupervisorOptions, statePath: string): Promise<UpdateState> {
  versionParts(options.version);
  if (!options.entryPoint.endsWith(".cjs")) throw new Error("automatic updates require a standalone .cjs bundle");
  const bytes = readFileSync(options.entryPoint);
  const hash = digest(bytes);
  const savedEntry = join(options.stateDir, "releases", hash, "cli.cjs");
  mkdirSync(dirname(savedEntry), { recursive: true, mode: 0o700 });
  if (!existsSync(savedEntry)) writeFileSync(savedEntry, bytes, { flag: "wx", mode: 0o600 });
  const installed: Release = { version: options.version, sha256: hash, entryPoint: savedEntry };
  if (!validRelease(installed)) throw new Error("installed relay bundle digest mismatch");
  let state: UpdateState = { schemaVersion: 1, phase: "starting", current: installed, updatedAt: Date.now() };
  if (existsSync(statePath)) {
    try {
      const stored = JSON.parse(readFileSync(statePath, "utf8")) as UpdateState;
      if (stored.schemaVersion !== 1) throw new Error("unknown update state");
      stored.current = readRelease(stored.current);
      if (stored.previous) stored.previous = readRelease(stored.previous);
      if (stored.handoff) {
        stored.handoff.candidate = readRelease(stored.handoff.candidate);
        stored.handoff.from = readRelease(stored.handoff.from);
        if (stored.current.sha256 !== stored.handoff.candidate.sha256) throw new Error("invalid supervisor handoff");
      }
      if (stored.pending) {
        stored.pending.candidate = readRelease(stored.pending.candidate);
        stored.pending.from = readRelease(stored.pending.from);
        stored.failed = {
          version: stored.pending.candidate.version, sha256: stored.pending.candidate.sha256,
          retryAfter: Date.now() + FAILED_COOLDOWN_MS, reason: "interrupted activation; recovered last verified release"
        };
        stored.current = stored.pending.from;
        delete stored.pending;
      }
      if (!validRelease(stored.current)) {
        const rejected = stored.current;
        const alternatives = [stored.previous, stored.handoff?.from, installed];
        stored.current = alternatives.find((release): release is Release => Boolean(release && validRelease(release)))!;
        if (stored.previous?.sha256 === stored.current.sha256) delete stored.previous;
        delete stored.handoff;
        delete stored.pending;
        stored.failed = {
          version: rejected.version, sha256: rejected.sha256, retryAfter: Date.now() + FAILED_COOLDOWN_MS,
          reason: "saved current release failed integrity verification"
        };
        stored.lastResult = { status: "recovered", reason: stored.failed.reason };
      }
      if (compareVersions(installed.version, stored.current.version) > 0
          && !(stored.failed?.sha256 === installed.sha256 && stored.failed.retryAfter > Date.now())) {
        stored.previous = stored.current;
        stored.current = installed;
        delete stored.handoff;
        delete stored.pending;
      }
      state = { ...stored, phase: "starting", updatedAt: Date.now() };
    } catch {
      renameSync(statePath, statePath + ".unreadable-" + randomUUID());
      options.log("unreadable update state preserved; using installed relay bundle");
    }
  }
  await atomicJson(statePath, state);
  return state;
}

/** Supervise one configured device; only candidates have bounded readiness deadlines. */
export async function runSupervisor(input: SupervisorOptions, runtime: SupervisorRuntime = {}): Promise<number> {
  const options = { ...input, entryPoint: resolve(input.entryPoint), stateDir: resolve(input.stateDir) };
  const manifestUrl = resolveManifestUrl(options.relayUrl, options.manifestUrl);
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs < 1_000) throw new Error("update interval must be at least one second");
  const drainMs = options.drainTimeoutMs ?? 30_000;
  const readyMs = options.readyTimeoutMs ?? 30_000;
  const stableMs = options.stabilityMs ?? 2_500;
  const fetcher = runtime.fetch ?? globalThis.fetch;
  const underLauncher = process.env.MCP_RELAY_LAUNCHED === "1";
  let handoffRequested = false;
  let supervisorNotified = false;
  let crashes = 0;
  let crashDigest = "";
  const releaseLock = await acquireUpdateLock(options.stateDir);
  const statePath = join(options.stateDir, "state.json");
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  const onInterrupt = () => shutdown.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) shutdown.abort();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const launcherMessage = (message: unknown) => {
    if (message && typeof message === "object" && (message as Record<string, unknown>).type === "relay:launcher-shutdown") shutdown.abort();
  };
  if (underLauncher) {
    process.on("disconnect", onInterrupt);
    process.on("message", launcherMessage);
  }
  let worker: Worker | undefined;
  let state: UpdateState | undefined;
  let nextCheck = 0;
  let seenRequest = checkRequest(options.stateDir);
  let seenReload = "";
  let nextReloadCheck = 0;
  const reloadAtStart = new WeakMap<Worker, WorkerReloadRequest>();
  const startWorker = (release: Release, paused: boolean): Worker => {
    // Capture before fork: a request already present is applied by this fresh
    // worker's normal CLI/config load, including after a supervisor restart.
    const requested = readReloadRequest(options.stateDir);
    const next = launchWorker(release, options.args, paused);
    if (requested) reloadAtStart.set(next, requested);
    return next;
  };
  let restartDelay = 1_000;
  const persist = async (phase: string) => {
    if (!state) return;
    state.phase = phase;
    state.supervisorVersion = options.version;
    state.updatedAt = Date.now();
    await atomicJson(statePath, state);
  };
  const failed = async (manifest: UpdateManifest, reason: string) => {
    if (!state) return;
    state.failed = { version: manifest.version, sha256: manifest.sha256, retryAfter: Date.now() + FAILED_COOLDOWN_MS, reason };
    state.lastResult = { status: "failed", version: manifest.version, reason };
    await persist("running");
  };

  const update = async (reload?: WorkerReloadRequest) => {
    if (!worker || !state || !worker.ready || worker.exited) return;
    const previousWorker = worker;
    const from = state.current;
    const oldPrevious = state.previous;
    let activationAttempted = false;
    let manifest: UpdateManifest | undefined;
    let candidate: Release;
    if (reload) {
      state.reload = { ...reload, status: "pending", updatedAt: Date.now() };
      if (!validRelease(from)) {
        state.reload = { ...reload, status: "failed", updatedAt: Date.now(), reason: "current verified bundle failed integrity verification" };
        state.lastResult = { status: "reload-failed", version: from.version, reason: state.reload.reason };
        await persist("running");
        return;
      }
      candidate = from;
    } else {
    const stageAbort = new AbortController();
    const abortStage = () => stageAbort.abort();
    previousWorker.child.once("exit", abortStage);
    const stageSignal = AbortSignal.any([shutdown.signal, stageAbort.signal]);
    try {
      state.checkedAt = Date.now();
      await persist("checking");
      manifest = validateUpdateManifest(JSON.parse(Buffer.from(await getBytes(manifestUrl, 64 * 1024, stageSignal, fetcher)).toString("utf8")), manifestUrl);
      const order = compareVersions(manifest.version, state.current.version);
      if (order <= 0) {
        state.lastResult = { status: order === 0 ? "current" : "older-release-ignored", version: manifest.version };
        await persist("running");
        return;
      }
      if (state.failed?.sha256 === manifest.sha256 && state.failed.retryAfter > Date.now()) {
        state.lastResult = { status: "cooldown", version: manifest.version };
        await persist("running");
        return;
      }
      await persist("staging");
      candidate = await stageBundle(manifest, options.stateDir, stageSignal, fetcher);
    } catch (error) {
      if (!shutdown.signal.aborted && !previousWorker.exited) {
        const reason = safeReason(error);
        options.log("update check/staging failed: " + reason + "; current relay remains active");
        if (manifest) await failed(manifest, reason);
        else {
          state.lastResult = { status: "check-failed", reason };
          await persist("running");
        }
      }
      return;
    } finally { previousWorker.child.removeListener("exit", abortStage); }
    }
    if (shutdown.signal.aborted || previousWorker.exited) return;

    const requestId = randomUUID();
    const drained = Promise.withResolvers<boolean>();
    previousWorker.drains.set(requestId, drained.resolve);
    await persist("draining");
    const requested = await waitFor(send(previousWorker, { type: "relay:drain", requestId }), 1_000, shutdown.signal);
    const idle = requested && await waitFor(drained.promise, drainMs, shutdown.signal);
    previousWorker.drains.delete(requestId);
    const deferredReason = previousWorker.drainReasons.get(requestId) ?? "in-flight tasks have not drained; update postponed";
    previousWorker.drainReasons.delete(requestId);
    if (!idle) {
      if (!previousWorker.exited) await waitFor(send(previousWorker, { type: "relay:resume", requestId }), 1_000);
      if (!shutdown.signal.aborted) {
        state.lastResult = { status: reload ? "reload-deferred" : "deferred", version: candidate.version, reason: deferredReason };
        if (reload) state.reload = { ...reload, status: "deferred", updatedAt: Date.now(), reason: deferredReason };
        await persist("running");
        options.log("update postponed; existing relay tasks continue: " + deferredReason);
      }
      return;
    }

    try {
      if (!reload) state.pending = { candidate, from, startedAt: Date.now() };
      await persist(reload ? "reloading" : "starting-candidate");
      await stopWorker(previousWorker);
      if (shutdown.signal.aborted) return;
      const next = startWorker(candidate, true);
      worker = next;
      const ready = await waitFor(next.readyPromise, readyMs, shutdown.signal);
      if (!ready) throw new Error("candidate did not confirm authenticated relay registration before its deadline");
      await waitFor(next.exitPromise, stableMs, shutdown.signal);
      if (shutdown.signal.aborted) return;
      if (next.exited) throw new Error("candidate exited during the health observation window");

      if (underLauncher && !reload) {
        state.previous = from;
        state.current = candidate;
        state.handoff = { candidate, from, startedAt: Date.now() };
        delete state.pending;
        delete state.failed;
        state.lastResult = { status: "handoff", version: candidate.version };
        await persist("handoff");
        await stopWorker(next);
        worker = undefined;
        handoffRequested = true;
        return;
      }

      // A local reload preserves release history, including an earlier failure.
      // Its bytes are the existing verified release, not a manifest candidate.
      if (!reload) {
        state.previous = from;
        state.current = candidate;
        delete state.pending;
        delete state.failed;
      }
      state.lastResult = { status: reload ? "reload-activating" : "updated", version: candidate.version };
      await persist("running");
      next.activationRequestId = "activate-" + randomUUID();
      activationAttempted = true;
      const activated = await waitFor(send(next, { type: "relay:resume", requestId: next.activationRequestId }), 1_000, shutdown.signal);
      if (!activated) throw new Error("candidate activation channel failed");
      delete next.activationRequestId;
      if (reload) {
        state.reload = { ...reload, status: "completed", updatedAt: Date.now() };
        state.lastResult = { status: "reloaded", version: candidate.version };
        await persist("running");
      }
      options.log(reload ? "relay worker reloaded the verified release " + candidate.version
        : "relay updated from " + from.version + " to " + candidate.version);
    } catch (error) {
      if (shutdown.signal.aborted) return;
      const reason = safeReason(error);
      if (activationAttempted && worker && worker !== previousWorker) {
        state.lastResult = { status: reload ? "reload-activation-pending" : "activation-pending", version: candidate.version, reason };
        if (reload) state.reload = { ...reload, status: "pending", updatedAt: Date.now(), reason };
        await persist("running");
        options.log("verified candidate activation is unconfirmed; retaining it and retrying without interrupting accepted calls");
        return;
      }
      if (worker && worker !== previousWorker) await stopWorker(worker);
      if (!previousWorker.exited) {
        await waitFor(send(previousWorker, { type: "relay:resume", requestId }), 1_000);
        worker = previousWorker;
      } else {
        if (!validRelease(from)) throw new Error("last verified relay bundle failed integrity verification");
        worker = startWorker(from, false);
      }
      state.current = from;
      state.previous = oldPrevious;
      delete state.handoff;
      delete state.pending;
      if (reload) {
        state.reload = { ...reload, status: "failed", updatedAt: Date.now(), reason };
        state.lastResult = { status: "reload-failed", version: from.version, reason };
        await persist("running");
      } else await failed(manifest!, reason);
      options.log((reload ? "local reload failed; retained verified relay " : "candidate rejected; restored relay ") + from.version + ": " + reason);
    }
  };

  try {
    state = await initializeState(options, statePath);
    const handoff = state.handoff;
    if (!shutdown.signal.aborted) worker = startWorker(state.current, Boolean(handoff));
    if (handoff && worker) {
      let activationAttempted = false;
      try {
        await persist("handoff");
        if (!await waitFor(worker.readyPromise, readyMs, shutdown.signal)) throw new Error("new supervisor worker did not confirm relay registration");
        await waitFor(worker.exitPromise, stableMs, shutdown.signal);
        if (shutdown.signal.aborted) return 0;
        if (worker.exited) throw new Error("new supervisor worker exited during health observation");
        if (underLauncher) {
          const permission = Promise.withResolvers<boolean>();
          const listener = (message: unknown) => {
            if (message && typeof message === "object" && (message as Record<string, unknown>).type === "relay:launcher-activate") permission.resolve(true);
          };
          process.on("message", listener);
          try {
            if (!await waitFor(sendParent({ type: "relay:supervisor-ready", version: state.current.version, supervisorVersion: options.version, activateRequired: true }), 1_000, shutdown.signal)) throw new Error("launcher control channel closed before activation");
            if (!await waitFor(permission.promise, readyMs, shutdown.signal)) throw new Error("launcher did not authorize candidate activation");
            supervisorNotified = true;
          } finally { process.removeListener("message", listener); }
        }
        delete state.handoff;
        state.lastResult = { status: "updated", version: state.current.version };
        await persist("running");
        worker.activationRequestId = "activate-" + randomUUID();
        activationAttempted = true;
        if (await waitFor(send(worker, { type: "relay:resume", requestId: worker.activationRequestId }), 1_000, shutdown.signal)) {
          delete worker.activationRequestId;
        }
        options.log("relay supervisor and worker now run " + state.current.version);
      } catch (error) {
        if (shutdown.signal.aborted) return 0;
        if (activationAttempted) {
          state.lastResult = { status: "activation-pending", version: state.current.version, reason: safeReason(error) };
        } else {
          await stopWorker(worker);
          worker = undefined;
          state.current = handoff.from;
          delete state.handoff;
          delete state.previous;
          state.failed = { version: handoff.candidate.version, sha256: handoff.candidate.sha256, retryAfter: Date.now() + FAILED_COOLDOWN_MS, reason: safeReason(error) };
          state.lastResult = { status: "rolled-back", version: handoff.from.version, reason: safeReason(error) };
          await persist("handoff");
          handoffRequested = true;
          return 75;
        }
      }
    }
    while (!shutdown.signal.aborted && !handoffRequested) {
      if (!worker) break;
      if (worker.exited) {
        const ranLongEnough = Date.now() - worker.startedAt >= 60_000;
        crashes = crashDigest === state.current.sha256 && !ranLongEnough ? crashes + 1 : 1;
        crashDigest = state.current.sha256;
        if (crashes >= 3 && state.previous && validRelease(state.previous)) {
          const rejected = state.current;
          const fallback = state.previous;
          state.current = fallback;
          delete state.previous;
          state.failed = { version: rejected.version, sha256: rejected.sha256, retryAfter: Date.now() + FAILED_COOLDOWN_MS, reason: "release repeatedly exited shortly after startup" };
          state.lastResult = { status: "rolled-back", version: fallback.version, reason: state.failed.reason };
          crashes = 0;
          restartDelay = 1_000;
          if (underLauncher) {
            await persist("handoff");
            worker = undefined;
            handoffRequested = true;
            return 75;
          }
        }
        await persist("restarting");
        options.log("relay worker exited; restarting the verified release");
        await delay(restartDelay, undefined, { signal: shutdown.signal }).catch(() => {});
        if (shutdown.signal.aborted) break;
        if (!validRelease(state.current)) throw new Error("verified relay bundle failed integrity verification");
        worker = startWorker(state.current, false);
        restartDelay = Math.min(restartDelay * 2, 30_000);
        continue;
      }
      if (worker.ready) {
        if (Date.now() - worker.startedAt >= 60_000) { restartDelay = 1_000; crashes = 0; }
        if (underLauncher && !supervisorNotified) {
          supervisorNotified = Boolean(await waitFor(sendParent({ type: "relay:supervisor-ready", version: state.current.version, supervisorVersion: options.version, activateRequired: false }), 1_000, shutdown.signal));
        }
        if (worker.activationRequestId) {
          if (await waitFor(send(worker, { type: "relay:resume", requestId: worker.activationRequestId }), 1_000, shutdown.signal)) {
            delete worker.activationRequestId;
            state.lastResult = { status: "updated", version: state.current.version };
            await persist("running");
          } else {
            await waitFor(worker.exitPromise, 1_000, shutdown.signal);
            continue;
          }
        }
        if (state.phase === "starting" || state.phase === "restarting") await persist("running");
        const requestedReload = readReloadRequest(options.stateDir);
        const loadedReload = reloadAtStart.get(worker);
        let handledReload = false;
        if (requestedReload && loadedReload?.id === requestedReload.id
          && !(state.reload?.id === requestedReload.id && ["completed", "failed"].includes(state.reload.status))) {
          state.reload = { ...requestedReload, status: "completed", updatedAt: Date.now() };
          state.lastResult = { status: "reloaded", version: state.current.version };
          await persist("running");
          handledReload = true;
        }
        const consumedReload = requestedReload && state.reload?.id === requestedReload.id
          && ["completed", "failed"].includes(state.reload.status);
        if (requestedReload && !consumedReload
          && (requestedReload.id !== seenReload || Date.now() >= nextReloadCheck)) {
          seenReload = requestedReload.id;
          nextReloadCheck = Date.now() + pollMs;
          try { await update(requestedReload); }
          catch (error) {
            const reason = safeReason(error);
            state.reload = { ...requestedReload, status: "failed", updatedAt: Date.now(), reason };
            await persist("running");
            options.log("local reload control failed; keeping the current worker: " + reason);
          }
          handledReload = true;
        }
        const request = checkRequest(options.stateDir);
        if (!handledReload && (Date.now() >= nextCheck || request !== seenRequest)) {
          seenRequest = request;
          nextCheck = Date.now() + Math.round(pollMs * (0.8 + Math.random() * 0.4));
          try { await update(); }
          catch (error) { options.log("update control operation failed; keeping the current worker: " + safeReason(error)); }
        }
      }
      if (worker) await waitFor(worker.exitPromise, Math.min(1_000, pollMs), shutdown.signal);
    }
    return handoffRequested ? 75 : 0;
  } finally {
    shutdown.abort();
    options.signal?.removeEventListener("abort", abort);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    if (underLauncher) {
      process.removeListener("disconnect", onInterrupt);
      process.removeListener("message", launcherMessage);
    }
    try {
      if (worker) await stopWorker(worker);
      if (!handoffRequested) await persist("stopped");
    } finally { await releaseLock(); }
  }
}


/**
 * Stable process launcher. It only selects a verified entry, starts one complete
 * supervisor and follows exit 75. All polling, transport and rollback decisions
 * run from the selected release, so updating never leaves an old updater in charge.
 */
export async function runLauncher(input: SupervisorOptions): Promise<number> {
  const options = { ...input, entryPoint: resolve(input.entryPoint), stateDir: resolve(input.stateDir) };
  const releaseLock = await acquireUpdateLock(options.stateDir, "launcher");
  const statePath = join(options.stateDir, "state.json");
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) shutdown.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let child: ChildProcess | undefined;
  let childExited = true;
  let childExit = Promise.resolve<{ code: number | null }>({ code: 0 });
  let rapidExits = 0;
  let restartDelay = 1_000;

  const stopSupervisor = async () => {
    if (!child || childExited) return;
    if (child.connected) {
      await waitFor(new Promise<boolean>((done) => {
        try { child!.send({ type: "relay:launcher-shutdown" }, (error) => done(!error)); }
        catch { done(false); }
      }), 1_000);
    }
    await waitFor(childExit, 10_000);
    if (!childExited) { child.kill("SIGTERM"); await waitFor(childExit, 3_000); }
    if (!childExited) { child.kill("SIGKILL"); await waitFor(childExit, 3_000); }
    if (!childExited) throw new Error("old relay supervisor could not be stopped");
  };

  const loadState = (): UpdateState => {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as UpdateState;
    if (state.schemaVersion !== 1) throw new Error("invalid launcher state");
    state.current = readRelease(state.current);
    if (state.previous) state.previous = readRelease(state.previous);
    if (state.handoff) {
      state.handoff.from = readRelease(state.handoff.from);
      state.handoff.candidate = readRelease(state.handoff.candidate);
    }
    return state;
  };

  const rollBack = async (state: UpdateState, reason: string): Promise<boolean> => {
    const fallback = state.handoff?.from ?? state.previous;
    if (!fallback || !validRelease(fallback)) return false;
    const rejected = state.current;
    state.current = fallback;
    delete state.previous;
    delete state.handoff;
    delete state.pending;
    delete state.supervisorVersion;
    state.failed = { version: rejected.version, sha256: rejected.sha256, retryAfter: Date.now() + FAILED_COOLDOWN_MS, reason };
    state.lastResult = { status: "rolled-back", version: fallback.version, reason };
    state.phase = "launcher-rollback";
    state.updatedAt = Date.now();
    await atomicJson(statePath, state);
    options.log("restored supervisor " + fallback.version + ": " + reason);
    return true;
  };

  try {
    await initializeState(options, statePath);
    while (!shutdown.signal.aborted) {
      let state = loadState();
      if (!validRelease(state.current)) {
        if (!await rollBack(state, "supervisor entry failed integrity verification")) throw new Error("no verified supervisor entry is available");
        state = loadState();
      }
      const target = state.current;
      const startedAt = Date.now();
      const ready = Promise.withResolvers<boolean>();
      const exit = Promise.withResolvers<{ code: number | null }>();
      let permitActivation = true;
      let readySeen = false;
      childExited = false;
      childExit = exit.promise;
      child = fork(target.entryPoint, options.args, {
        execArgv: [], windowsHide: true, stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: {
          ...process.env, MCP_RELAY_LAUNCHED: "1", MCP_RELAY_SUPERVISOR: "1",
          MCP_RELAY_WORKER: "0", MCP_RELAY_START_DRAINED: "0"
        }
      });
      const supervisor = child;
      const finish = (code: number | null) => {
        childExited = true;
        ready.resolve(false);
        exit.resolve({ code });
      };
      supervisor.once("exit", (code) => finish(code));
      supervisor.once("error", () => { if (!supervisor.pid) finish(2); });
      supervisor.on("message", (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const message = value as Record<string, unknown>;
        if (message.type !== "relay:supervisor-ready" || message.version !== target.version
            || message.supervisorVersion !== target.version || !permitActivation) return;
        // Cancel health-failure eligibility before granting permission to accept calls.
        readySeen = true;
        ready.resolve(true);
        if (message.activateRequired === true && supervisor.connected) {
          try { supervisor.send({ type: "relay:launcher-activate" }, () => {}); }
          catch { /* A closed IPC channel is handled by child exit and rollback. */ }
        }
      });

      if (state.handoff) {
        const deadline = (options.readyTimeoutMs ?? 30_000) + (options.stabilityMs ?? 2_500) + 10_000;
        const healthy = await waitFor(ready.promise, deadline, shutdown.signal);
        if (shutdown.signal.aborted) break;
        if (!healthy && !readySeen) {
          permitActivation = false;
          await stopSupervisor();
          if (!await rollBack(loadState(), "new supervisor failed its bounded startup health check")) {
            throw new Error("new supervisor failed and no verified predecessor is available");
          }
          rapidExits = 0;
          restartDelay = 1_000;
          continue;
        }
      }

      let result: { code: number | null } | undefined;
      while (!shutdown.signal.aborted && !result) {
        result = await waitFor(childExit, 24 * 60 * 60 * 1000, shutdown.signal);
      }
      if (shutdown.signal.aborted) break;
      state = loadState();
      if (result?.code === 75) {
        // The previous supervisor released its lock and stopped its paused worker.
        rapidExits = 0;
        restartDelay = 1_000;
        continue;
      }
      if (state.handoff) {
        if (!await rollBack(state, "new supervisor exited before completing activation")) throw new Error("supervisor handoff could not be recovered");
        rapidExits = 0;
        restartDelay = 1_000;
      } else {
        rapidExits = Date.now() - startedAt >= 60_000 ? 1 : rapidExits + 1;
        if (rapidExits >= 3 && await rollBack(state, "supervisor repeatedly exited shortly after startup")) {
          rapidExits = 0;
          restartDelay = 1_000;
        } else if (rapidExits >= 10) {
          throw new Error("supervisor repeatedly failed without an available verified predecessor");
        }
      }
      // A crashed supervisor's worker observes IPC disconnect and closes its relay
      // connection before the next supervisor starts. No OS-wide process killing.
      await delay(restartDelay, undefined, { signal: shutdown.signal }).catch(() => {});
      restartDelay = Math.min(restartDelay * 2, 30_000);
    }
    return 0;
  } finally {
    shutdown.abort();
    options.signal?.removeEventListener("abort", abort);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    try { await stopSupervisor(); }
    finally { await releaseLock(); }
  }
}