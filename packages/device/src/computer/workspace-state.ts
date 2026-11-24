import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CapturedScreen, ComputerAction, ComputerState, NativeContext } from "./types.js";
import { ComputerError } from "./types.js";
import type { WorkspaceCloseReason, WorkspaceOpenOptions, WorkspaceOwner, WorkspacePhase, WorkspaceProvider,
  WorkspaceProviderContext, WorkspaceRecoveryResult, WorkspaceResource } from "./workspace-types.js";

export interface WorkspaceJournal {
  schema: 1;
  leaseId: string;
  providerId: string;
  owner: WorkspaceOwner;
  options: WorkspaceOpenOptions;
  phase: WorkspacePhase;
  createdAt: number;
  updatedAt: number;
  resource?: WorkspaceResource;
  recovery?: WorkspaceRecoveryResult;
  reason?: WorkspaceCloseReason;
  lastError?: string;
}
export interface WorkspaceControllerOptions {
  directory: string;
  journal: WorkspaceJournal;
  provider: WorkspaceProvider;
  wallNow?: () => number;
  monotonicNow?: () => number;
  persist?: (journal: WorkspaceJournal) => Promise<void>;
  revoke?: (value: { schema: 1; leaseId: string; reason: WorkspaceCloseReason; revokedAt: number }) => Promise<void>;
  ownerTimeoutMs?: number;
  transportTimeoutMs?: number;
}
export async function writeWorkspaceJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, path); return; }
    catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}
export function readWorkspaceJson<T>(path: string): T {
  const bytes = readFileSync(path);
  if (bytes.length > 256 * 1024) throw new ComputerError("workspace_journal_invalid", "Workspace journal is too large.");
  return JSON.parse(bytes.toString("utf8")) as T;
}
const fault = (code: string, message: string) => new ComputerError(code, message);

/** One lease, owned by the out-of-process broker. No provider receives a bearer token. */
export class WorkspaceController {
  readonly journal: WorkspaceJournal;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly saveJournal: (journal: WorkspaceJournal) => Promise<void>;
  private readonly ownerTimeout: number;
  private readonly transportTimeout: number;
  private readonly hardMonotonicDeadline: number;
  private expiryMonotonicDeadline: number;
  private ownerHeartbeatAt: number;
  private serverMessageAt: number;
  private providerHeartbeatAt = -Infinity;
  private activeAbort = new AbortController();
  private operating = false;
  private openingProvider = false;
  private restoring?: Promise<WorkspaceRecoveryResult>;
  private readonly receipts = new Map<string, { fingerprint: string; result?: Record<string, unknown>; unknown: boolean }>();

  constructor(private readonly options: WorkspaceControllerOptions) {
    this.journal = structuredClone(options.journal);
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.saveJournal = options.persist ?? (journal => writeWorkspaceJson(join(options.directory, "journal.json"), journal));
    this.ownerTimeout = options.ownerTimeoutMs ?? 15000;
    this.transportTimeout = options.transportTimeoutMs ?? 65000;
    const mono = this.monotonicNow(), wall = this.wallNow();
    this.hardMonotonicDeadline = mono + Math.max(0, Math.min(this.journal.options.hardExpiresAt,
      this.journal.owner.authorizationExpiresAt) - wall);
    this.expiryMonotonicDeadline = Math.min(this.hardMonotonicDeadline,
      mono + Math.max(0, this.journal.options.expiresAt - wall));
    this.ownerHeartbeatAt = mono;
    this.serverMessageAt = wall;
  }
  private async persist(): Promise<void> {
    this.journal.updatedAt = this.wallNow();
    await this.saveJournal(structuredClone(this.journal));
  }
  private context(signal?: AbortSignal, timeoutMs = 30000, recovery = false): WorkspaceProviderContext {
    return {
      timeoutMs, ...(signal ? { signal } : {}), journalDirectory: this.options.directory,
      revocationPath: join(this.options.directory, "revoked.json"),
      checkpoint: async resource => {
        if (resource.leaseId !== this.journal.leaseId || resource.providerId !== this.journal.providerId
          || !resource.instanceId || Buffer.byteLength(JSON.stringify(resource)) > 128 * 1024) {
          throw fault("workspace_resource_invalid", "Provider returned an invalid resource ownership record.");
        }
        if (this.journal.phase === "closed") this.journal.phase = "cleanup_pending";
        this.journal.resource = structuredClone(resource);
        await this.persist();
        if (!recovery && (this.activeAbort.signal.aborted || this.revokedOnDisk())) throw fault("workspace_closed", "Workspace creation was permanently revoked.");
      }
    };
  }
  authorize(owner: WorkspaceOwner, requireCurrentAuthorization = true): void {
    if (!owner || owner.ownerKey !== this.journal.owner.ownerKey || owner.connectionEpoch !== this.journal.owner.connectionEpoch) {
      throw fault("workspace_owner_mismatch", "The workspace belongs to another authenticated connection.");
    }
    if (requireCurrentAuthorization && (!Number.isFinite(owner.authorizationExpiresAt) || owner.authorizationExpiresAt <= this.wallNow())) {
      throw fault("workspace_authorization_expired", "Workspace authorization expired.");
    }
  }
  status(): Record<string, unknown> {
    return {
      lease_id: this.journal.leaseId, state: this.journal.phase, provider: this.journal.providerId,
      expires_at: this.journal.options.expiresAt, hard_expires_at: this.journal.options.hardExpiresAt,
      ...(this.journal.resource ? { display: this.journal.resource.display, instance_id: this.journal.resource.instanceId } : {}),
      ...(this.journal.recovery ? { recovery: this.journal.recovery } : {}),
      ...(this.journal.reason ? { close_reason: this.journal.reason } : {}),
      ...(this.journal.lastError ? { cleanup_error: this.journal.lastError } : {}),
      input_allowed: this.journal.phase === "active" && this.expiryReason() === undefined
    };
  }
  heartbeat(owner: WorkspaceOwner, lastServerMessageAt: number): void {
    this.authorize(owner);
    if (this.journal.phase !== "active" && this.journal.phase !== "preparing") return;
    if (!Number.isFinite(lastServerMessageAt) || lastServerMessageAt > this.wallNow() + 5000) {
      throw fault("workspace_transport_invalid", "Invalid authenticated transport heartbeat.");
    }
    this.ownerHeartbeatAt = this.monotonicNow();
    this.serverMessageAt = lastServerMessageAt;
  }
  async open(): Promise<Record<string, unknown>> {
    if (this.journal.phase !== "preparing" || this.operating) throw fault("workspace_state", "Workspace creation already started.");
    this.operating = true;
    try {
      const initialExpiry = this.expiryReason();
      if (initialExpiry) { await this.close(initialExpiry); throw fault("workspace_closed", "Workspace creation was revoked or its deadline expired."); }
      // The intent is durable before the provider can create any external resource.
      await this.persist();
      const capabilities = await this.options.provider.probe(this.context(this.activeAbort.signal));
      if (!capabilities.available || !capabilities.isolated || !capabilities.independentWatchdog
        || capabilities.recovery === "unsupported") {
        throw fault("isolated_workspace_unavailable", capabilities.reason ?? "This provider cannot safely isolate and restore a workspace.");
      }
      if (this.journal.options.windowIds?.length && !capabilities.canAdoptWindows) {
        throw fault("workspace_window_adoption_unsupported", "This provider cannot move existing physical-session windows into its private session.");
      }
      this.activeAbort.signal.throwIfAborted();
      const beforeCreationExpiry = this.expiryReason();
      if (beforeCreationExpiry) { await this.close(beforeCreationExpiry); throw fault("workspace_closed", "Workspace creation was revoked or its deadline expired."); }
      this.openingProvider = true;
      let resource: WorkspaceResource;
      try { resource = await this.options.provider.open(this.journal.options, this.context(this.activeAbort.signal, 120000)); }
      finally { this.openingProvider = false; }
      await this.context().checkpoint(resource);
      if (this.activeAbort.signal.aborted || this.journal.phase !== "preparing") {
        await this.close(this.journal.reason ?? "open_failed");
        throw fault("workspace_closed", "Workspace closed while creation was in progress.");
      }
      this.journal.phase = "active";
      await this.persist();
      return { ...this.status(), isolation: capabilities, requires_new_frame: true };
    } catch (error) {
      await this.close("open_failed");
      throw error;
    } finally { this.operating = false; }
  }
  private revokedOnDisk(): boolean { return existsSync(join(this.options.directory, "revoked.json")); }
  private expiryReason(): WorkspaceCloseReason | undefined {
    if (this.revokedOnDisk()) return this.journal.reason ?? "recovery";
    const wall = this.wallNow(), mono = this.monotonicNow();
    if (wall >= this.journal.owner.authorizationExpiresAt || mono >= this.hardMonotonicDeadline) return "authorization_expired";
    if (wall >= this.journal.options.expiresAt || mono >= this.expiryMonotonicDeadline) return "expired";
    if (mono - this.ownerHeartbeatAt >= this.ownerTimeout) return "owner_lost";
    if (wall - this.serverMessageAt >= this.transportTimeout) return "disconnected";
    return undefined;
  }
  private activeResource(): WorkspaceResource {
    const reason = this.expiryReason();
    if (reason && this.journal.phase === "active") void this.close(reason);
    if (this.journal.phase !== "active" || !this.journal.resource) throw fault("workspace_closed", "This workspace no longer accepts agent input or screenshots.");
    return this.journal.resource;
  }
  private async operation<T>(timeoutMs: number, run: (resource: WorkspaceResource, context: NativeContext) => Promise<T>, expectedAppId?: string): Promise<T> {
    const resource = this.activeResource();
    if (this.operating) throw fault("workspace_busy", "Another workspace operation is in progress.");
    this.operating = true;
    const remaining = Math.min(this.expiryMonotonicDeadline - this.monotonicNow(),
      this.journal.options.expiresAt - this.wallNow(), this.journal.owner.authorizationExpiresAt - this.wallNow());
    const boundedTimeout = Math.max(1, Math.min(120000, timeoutMs, remaining));
    const deadline = AbortSignal.timeout(boundedTimeout);
    const signal = AbortSignal.any([deadline, this.activeAbort.signal]);
    const expire = () => { void this.close("expired"); };
    deadline.addEventListener("abort", expire, { once: true });
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(fault("workspace_cancelled", "Workspace operation was cancelled and recovery started."));
      signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      const work = run(resource, { timeoutMs: boundedTimeout, signal, ...(expectedAppId ? { expectedAppId } : {}) });
      if (signal.aborted) rejectAborted!();
      return await Promise.race([work, aborted]);
    }
    catch (error) {
      if (signal.aborted) void this.close(deadline.aborted ? "expired" : this.journal.reason ?? "disconnected");
      throw error;
    } finally { deadline.removeEventListener("abort", expire); if (rejectAborted) signal.removeEventListener("abort", rejectAborted); this.operating = false; }
  }
  inspect(timeoutMs: number, expectedAppId?: string): Promise<ComputerState> {
    return this.operation(timeoutMs, async (resource, context) => {
      const state = await this.options.provider.inspect(resource, context);
      if (state.displayKind !== "virtual" || !state.displays.some(display => display.id === resource.display.id
        && display.instanceId === resource.display.instanceId)) throw fault("workspace_target_changed", "Provider no longer exposes this lease's private display.");
      return state;
    }, expectedAppId);
  }
  capture(timeoutMs: number, expectedAppId?: string): Promise<CapturedScreen> {
    return this.operation(timeoutMs, async (resource, context) => {
      const screen = await this.options.provider.capture(resource, context);
      if (screen.display.id !== resource.display.id || screen.display.instanceId !== resource.display.instanceId) {
        throw fault("workspace_target_changed", "Provider returned a different display; physical-screen fallback was refused.");
      }
      return screen;
    }, expectedAppId);
  }
  async act(requestId: string, action: ComputerAction, timeoutMs: number, expectedAppId?: string): Promise<Record<string, unknown>> {
    const fingerprint = createHash("sha256").update(JSON.stringify({ action, expectedAppId })).digest("hex");
    const previous = this.receipts.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fault("request_id_conflict", "Workspace request ID was reused with different input.");
      if (previous.unknown) throw fault("workspace_action_unknown", "The previous input outcome is unknown; it will not be replayed.");
      return { ...previous.result, cached: true };
    }
    this.activeResource();
    if (this.operating) throw fault("workspace_busy", "Another workspace operation is in progress.");
    this.receipts.set(requestId, { fingerprint, unknown: true });
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
    const result = await this.operation(timeoutMs, (resource, context) => this.options.provider.act(resource, action, context), expectedAppId);
    this.receipts.set(requestId, { fingerprint, unknown: false, result });
    return result;
  }
  async renew(owner: WorkspaceOwner, durationMs: number): Promise<Record<string, unknown>> {
    this.authorize(owner);
    const resource = this.activeResource();
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 300000) throw fault("workspace_invalid_ttl", "Workspace renewal must be 1–300 seconds.");
    const wall = this.wallNow(), mono = this.monotonicNow();
    const expiresAt = Math.min(wall + durationMs, this.journal.options.hardExpiresAt,
      this.journal.owner.authorizationExpiresAt, owner.authorizationExpiresAt);
    if (expiresAt <= wall) { await this.close("authorization_expired"); throw fault("workspace_authorization_expired", "Workspace authorization expired."); }
    // Commit the durable deadline before extending the provider's own watchdog.
    this.journal.options.expiresAt = expiresAt;
    this.expiryMonotonicDeadline = Math.min(this.hardMonotonicDeadline, mono + expiresAt - wall);
    await this.persist();
    try { await this.options.provider.renew(resource, expiresAt, this.context(this.activeAbort.signal)); }
    catch (error) { await this.close("owner_lost"); throw error; }
    this.ownerHeartbeatAt = mono;
    return this.status();
  }
  async close(reason: WorkspaceCloseReason): Promise<WorkspaceRecoveryResult> {
    if (this.journal.phase === "closed") return this.journal.recovery!;
    if (this.restoring) return this.restoring;
    this.activeAbort.abort(fault("workspace_closed", "Workspace input was revoked."));
    this.journal.phase = "restoring";
    this.journal.reason ??= reason;
    this.restoring = (async () => {
      let durableFence = false;
      const revoke = this.options.revoke ?? (value => writeWorkspaceJson(join(this.options.directory, "revoked.json"), value));
      try {
        await revoke({ schema: 1, leaseId: this.journal.leaseId, reason: this.journal.reason!, revokedAt: this.wallNow() });
        durableFence = true;
        await this.persist();
      } catch { /* A full disk must not prevent independent native input revocation. */ }
      try {
        // Recovery never inherits the expired caller's signal.
        const nativeResult = await this.options.provider.recover(this.journal.resource, this.journal.options,
          this.journal.reason!, this.context(AbortSignal.timeout(120000), 120000, true));
        const settled = durableFence && !this.openingProvider && nativeResult.complete && nativeResult.inputRevoked
          && (nativeResult.ownedDisplayRemoved || nativeResult.outcome === "handoff-viewer");
        const result: WorkspaceRecoveryResult = settled ? nativeResult
          : { ...nativeResult, complete: false, outcome: "cleanup-pending" };
        this.journal.recovery = result;
        this.journal.phase = settled ? "closed" : "cleanup_pending";
        if (!settled) this.journal.lastError = "Provider creation, input revocation or durable cleanup has not settled.";
        else delete this.journal.lastError;
        try { await this.persist(); }
        catch {
          this.journal.phase = "cleanup_pending";
          this.journal.recovery = { ...result, complete: false, outcome: "cleanup-pending" };
          this.journal.lastError = "Recovery completed but its durable receipt could not be saved.";
        }
        return this.journal.recovery;
      } catch {
        this.journal.phase = "cleanup_pending";
        this.journal.lastError = "Workspace recovery did not complete; owned resources remain recorded for retry.";
        this.journal.recovery = { complete: false, outcome: "cleanup-pending", inputRevoked: false, ownedDisplayRemoved: false };
        try { await this.persist(); } catch { /* Keep in-memory input revoked and retry the durable receipt. */ }
        return this.journal.recovery;
      }
    })().finally(() => { this.restoring = undefined; });
    return this.restoring;
  }
  async tick(): Promise<void> {
    if (this.journal.phase === "closed" || this.journal.phase === "restoring") return;
    if (this.journal.phase === "cleanup_pending") { await this.close(this.journal.reason ?? "recovery"); return; }
    const reason = this.expiryReason(), mono = this.monotonicNow();
    if (reason) await this.close(reason);
    else if (this.journal.phase === "active" && this.journal.resource && mono - this.providerHeartbeatAt >= 2000) {
      this.providerHeartbeatAt = mono;
      try {
        // Native guardian liveness is renewed without extending the agent lease.
        await this.options.provider.renew(this.journal.resource, this.journal.options.expiresAt,
          this.context(AbortSignal.any([this.activeAbort.signal, AbortSignal.timeout(3000)]), 3000));
      } catch { await this.close("owner_lost"); }
    }
  }
}
