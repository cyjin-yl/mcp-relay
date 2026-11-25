import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject } from "@mcp-relay/shared";
import { pngDimensions } from "./native.js";
import { windowsKeyCodes } from "./windows.js";
import { ComputerError, type ComputerAction, type ComputerDisplay, type NativeContext } from "./types.js";
import type { WorkspaceOpenOptions, WorkspaceProvider, WorkspaceProviderContext, WorkspaceResource } from "./workspace-types.js";
import { ANODE_SOURCE_COMMIT, anodeRequest, anodeRuntimePath, hiddenPowerShellArguments, installAnodeRuntime,
  verifyAnodeRuntime, windowsScriptHost, windowsWorkspaceNative, writePrivateJson, writeWindowsWorkspaceHelpers,
  writeWindowsWorkspaceRevocation } from "./workspace-windows-runtime.js";

const ID = "windows-anode-child-session";
const ACTIONS = ["move", "click", "drag", "scroll", "key", "text"] as const;
type Data = {
  channel: string; agentId: string; leaseToken?: string; stateFile: string; runtimeExe: string;
  instanceId: string; parentSession: number; childSession?: number; seatPid?: number;
  brokerPid: number; brokerStarted: string; expiresAt: number; hardExpiresAt: number;
  sequence: number; phase: string; closeReason?: string; revocationPath: string; width: number; height: number; interactiveSignIn: boolean;
};
export interface WindowsWorkspaceDependencies {
  runtimePath(): string;
  verifyRuntime(path?: string): Promise<void>;
  installRuntime(context: NativeContext): Promise<Record<string, unknown>>;
  native(request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>>;
  request(channel: string, request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>>;
  writeJson(path: string, value: unknown): Promise<void>;
  writeHelpers(directory: string): Promise<void>;
  readArtifact(path: string): Promise<Record<string, unknown> | undefined>;
  revoked(path: string): Promise<boolean>;
  revoke(path: string, reason: string): Promise<void>;
  readRecovery(path: string): Promise<Record<string, unknown> | undefined>;
  now(): number;
}
const system: WindowsWorkspaceDependencies = {
  runtimePath: anodeRuntimePath, verifyRuntime: verifyAnodeRuntime, installRuntime: installAnodeRuntime,
  native: windowsWorkspaceNative, request: anodeRequest, writeJson: writePrivateJson,
  writeHelpers: writeWindowsWorkspaceHelpers, revoke: writeWindowsWorkspaceRevocation,
  async revoked(path) {
    try { await access(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  },
  async readArtifact(path) {
    try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  async readRecovery(path) {
    try { return JSON.parse(await readFile(path + ".recovery.json", "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  now: Date.now,
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function data(resource: WorkspaceResource): Data {
  const d = resource.data as unknown as Data;
  if (resource.providerId !== ID || resource.instanceId !== d.instanceId || !/^mcp-relay-[a-f0-9]{16}$/.test(d.channel)
    || !d.stateFile || !d.runtimeExe || !d.revocationPath || !integer(d.parentSession) || d.parentSession <= 0
    || !integer(d.brokerPid) || typeof d.brokerStarted !== "string") {
    throw new ComputerError("WORKSPACE_IDENTITY_INVALID", "The Windows workspace ownership record is invalid.");
  }
  return d;
}
export function validateAnodeStatus(status: Record<string, unknown>, resource: WorkspaceResource, ready = true): void {
  const d = data(resource), guard = object(status.pointerGuard), seat = object(status.seat);
  if (status.channel !== d.channel || status.parentSession !== d.parentSession
    || (d.childSession !== undefined && status.session !== d.childSession)
    || (d.seatPid !== undefined && seat?.pid !== d.seatPid)) {
    throw new ComputerError("WORKSPACE_IDENTITY_CHANGED", "The owned Windows child session changed; input is refused.");
  }
  if (ready && (status.state !== "ready" || status.agentReady !== true || status.viewerConnection !== 1
      || !integer(status.session) || status.session <= 0 || status.session === d.parentSession
      || seat?.session !== status.session || !integer(seat.pid) || seat.pid <= 0)) {
    throw new ComputerError("WORKSPACE_NOT_READY", String(status.lastError ?? "The isolated Windows child session is not ready."));
  }
  if (guard?.installed !== true || !integer(guard.patchedImports) || guard.patchedImports < 1)
    throw new ComputerError("WORKSPACE_POINTER_GUARD_UNAVAILABLE", "The native RDP pointer isolation guard is not verified; input is refused.");
  if (status.viewOnly !== true) throw new ComputerError("WORKSPACE_USER_CONTROL", "The user has taken control of the retained desktop; agent input is paused.");
}
function display(resource: WorkspaceResource, status: Record<string, unknown>): ComputerDisplay {
  const screen = object(object(status.seat)?.screen);
  if (!integer(screen?.width) || !integer(screen?.height) || screen.width !== resource.display.width
      || screen.height !== resource.display.height) throw new ComputerError("WORKSPACE_DISPLAY_CHANGED", "The child-session display changed; reopen the workspace before input.");
  return resource.display;
}
function point(resource: WorkspaceResource, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= resource.display.width || y >= resource.display.height)
    throw new ComputerError("INVALID_COORDINATES", "Coordinates must be inside the isolated child-session screenshot.");
  return { x: Math.min(resource.display.width - 1, Math.round(x)), y: Math.min(resource.display.height - 1, Math.round(y)) };
}
export function mapAnodeAction(resource: WorkspaceResource, action: ComputerAction): Record<string, unknown>[] {
  switch (action.type) {
    case "move": return [{ op: "input.move", ...point(resource, action.x, action.y) }];
    case "click": {
      const count = action.clicks ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 3) throw new ComputerError("INVALID_ACTION", "Click count must be one through three.");
      if (count > 2) throw new ComputerError("UNSUPPORTED_ACTION_OPTION", "The isolated Windows runtime supports single or double click, not a third click.");
      return [{ op: "input.click", ...point(resource, action.x, action.y), button: action.button ?? "left", count }];
    }
    case "drag": {
      if (action.durationMs !== undefined)
        throw new ComputerError("UNSUPPORTED_ACTION_OPTION", "The isolated Windows runtime uses its native drag timing; custom duration is unsupported.");
      const from = point(resource, action.fromX, action.fromY), to = point(resource, action.toX, action.toY);
      return [{ op: "input.drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, button: "left" }];
    }
    case "scroll": {
      const amount = action.amount ?? 3;
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new ComputerError("INVALID_ACTION", "Scroll amount must be one through 100 ticks.");
      if ((action.x === undefined) !== (action.y === undefined)) throw new ComputerError("INVALID_COORDINATES", "Both scroll coordinates are required.");
      const move = action.x === undefined ? [] : [{ op: "input.move", ...point(resource, action.x, action.y!) }];
      return [...move, { op: "input.scroll", amount: amount * (action.direction === "down" || action.direction === "left" ? -1 : 1),
        horizontal: action.direction === "left" || action.direction === "right" }];
    }
    case "key": return [{ op: "input.key", keys: windowsKeyCodes(action.keys).map(code => "vk" + code.toString(16)).join("+") }];
    case "text":
      if (action.text.length > 10000) throw new ComputerError("INVALID_ACTION", "Workspace text is limited to 10000 UTF-16 code units.");
      return [{ op: "input.text", text: action.text, perCharMs: 0 }];
  }
}
export function createWindowsWorkspaceProvider(overrides: Partial<WindowsWorkspaceDependencies> = {}): WorkspaceProvider {
  const dep = { ...system, ...overrides };
  async function save(resource: WorkspaceResource, context: WorkspaceProviderContext): Promise<void> {
    await context.checkpoint(resource);
    await dep.writeJson(data(resource).stateFile, { ...data(resource), leaseId: resource.leaseId });
  }
  async function assertNotRevoked(resource: WorkspaceResource, context: NativeContext): Promise<Data> {
    const d = data(resource);
    if (await dep.revoked(d.revocationPath) || await dep.revoked(d.stateFile + ".revoked.json"))
      throw new ComputerError("WORKSPACE_HANDED_OFF", "This workspace has been permanently revoked; agent input and late creation are refused.");
    if (context.signal?.aborted) throw new ComputerError("cancelled", "The workspace request was cancelled.", { mayHaveApplied: false });
    return d;
  }
  async function assertCreating(resource: WorkspaceResource, context: NativeContext): Promise<void> {
    const d = await assertNotRevoked(resource, context);
    if (d.phase !== "preparing" || dep.now() >= Math.min(d.expiresAt, d.hardExpiresAt))
      throw new ComputerError("WORKSPACE_LEASE_EXPIRED", "Workspace creation has ended.");
  }
  async function guard(resource: WorkspaceResource, context: NativeContext): Promise<Data> {
    const d = await assertNotRevoked(resource, context);
    if (d.phase !== "active" || dep.now() >= Math.min(d.expiresAt, d.hardExpiresAt))
      throw new ComputerError("WORKSPACE_LEASE_EXPIRED", "The isolated workspace lease has ended.");
    if (await dep.readRecovery(d.stateFile)) throw new ComputerError("WORKSPACE_HANDED_OFF", "The native watchdog has handed this desktop back; agent input is revoked.");
    if (context.signal?.aborted) throw new ComputerError("cancelled", "The workspace request was cancelled.", { mayHaveApplied: false });
    return d;
  }
  function deadline(d: Data, context: NativeContext): NativeContext {
    const remaining = Math.min(d.expiresAt, d.hardExpiresAt) - dep.now();
    if (remaining < 1500) throw new ComputerError("WORKSPACE_LEASE_EXPIRING", "The workspace lease is too close to expiry for another native action.");
    return { ...context, timeoutMs: Math.max(1, Math.min(context.timeoutMs, remaining - 500, 10000)) };
  }
  async function status(resource: WorkspaceResource, context: NativeContext, checkLease = true): Promise<Record<string, unknown>> {
    const d = checkLease ? await guard(resource, context) : data(resource);
    const value = await dep.request(d.channel, { op: "status", agentId: d.agentId }, context);
    validateAnodeStatus(value, resource);
    display(resource, value);
    return value;
  }
  async function ownedRequest(resource: WorkspaceResource, request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
    const d = await guard(resource, context);
    const value = await dep.request(d.channel, { ...request, agentId: d.agentId, leaseToken: d.leaseToken }, deadline(d, context));
    return value;
  }
  return {
    id: ID,
    async setup(context) {
      const installed = await dep.installRuntime(context);
      const native = await dep.native({ op: "inspect", brokerPid: process.pid }, context);
      return { ...installed, childSessionsEnabled: native.enabled === true,
        ready: native.enabled === true && native.elevated === false && native.interactive === true && Number(native.parentSession) > 0,
        ...(!native.enabled ? { nextStep: "An administrator must explicitly enable Windows child sessions. This setup does not change firewall or credential policy." } : {}) };
    },
    async probe(context) {
      try {
        await dep.verifyRuntime();
        const native = await dep.native({ op: "inspect", brokerPid: process.pid }, context);
        const reason = native.scriptHostAvailable !== true ? "Windows Script Host is unavailable; a verified windowless task launcher is required."
          : native.enabled !== true ? "Windows child sessions are disabled; explicit administrator setup is required."
          : native.elevated !== false ? "Start the workspace from the ordinary signed-in Windows user, not an elevated process."
          : native.interactive !== true || !integer(native.parentSession) || native.parentSession <= 0 || native.brokerSession !== native.parentSession
            ? "A signed-in interactive parent session is required; Session 0 and SSH cannot create the workspace."
            : native.childSession !== null && native.childSession !== undefined ? "A Windows child session is already retained. Continue in its viewer or close it explicitly before creating another workspace." : undefined;
        return { available: !reason, isolated: !reason, clipboardBoundary: "isolated", canAdoptWindows: false,
          recovery: "handoff-viewer", independentWatchdog: true, unicodeText: true, ...(reason ? { reason } : {}),
          details: { runtime: "Anode 0.11.5", sourceCommit: ANODE_SOURCE_COMMIT, parentSession: native.parentSession,
            existingChildSession: native.childSession ?? null, sameWindowsAccount: true, securitySandbox: false,
            nativeLeaseSeconds: 10, clipboardRedirection: false, audioRedirection: false, singletonsMayReuseExistingApplication: true,
            interactiveSignIn: "explicit-open-only", automaticSignInNotGuaranteed: true, signInMayBeRequiredAgainAfterReconnect: true } };
      } catch (error) {
        return { available: false, isolated: false, clipboardBoundary: "unsupported", canAdoptWindows: false,
          recovery: "handoff-viewer", independentWatchdog: true, unicodeText: true,
          reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async open(options, context) {
      if (options.windowIds?.length) throw new ComputerError("WORKSPACE_WINDOW_ADOPTION_UNSUPPORTED", "Windows HWNDs cannot move between sessions. Launch an application in the isolated workspace.");
      if (!Number.isInteger(options.width) || options.width < 640 || options.width > 8192 || options.width % 2
        || !Number.isInteger(options.height) || options.height < 480 || options.height > 8192)
        throw new ComputerError("INVALID_DISPLAY", "The child-session display needs an even width from 640–8192 and height from 480–8192.");
      if (options.launch && (!win32.isAbsolute(options.launch.executable) || !/\.exe$/i.test(options.launch.executable)
        || options.launch.args.some(arg => typeof arg !== "string" || arg.includes("\0"))))
        throw new ComputerError("INVALID_LAUNCH", "Specify an absolute Windows .exe path and literal arguments.");
      await dep.verifyRuntime();
      const native = await dep.native({ op: "inspect", brokerPid: process.pid }, context);
      if (native.scriptHostAvailable !== true) throw new ComputerError("WORKSPACE_SETUP_REQUIRED", "Windows Script Host is unavailable; workspace console helpers will not be launched visibly.");
      if (native.enabled !== true) throw new ComputerError("WORKSPACE_SETUP_REQUIRED", "Windows child sessions must be explicitly enabled before opening a workspace.");
      if (native.elevated !== false || native.interactive !== true || !integer(native.parentSession) || native.parentSession <= 0
        || native.brokerSession !== native.parentSession || typeof native.brokerStarted !== "string")
        throw new ComputerError("INTERACTIVE_SESSION_REQUIRED", "Create the child session from the ordinary signed-in interactive Windows session.");
      if (native.childSession !== null && native.childSession !== undefined)
        throw new ComputerError("WORKSPACE_BUSY", "An existing Windows child session is retained; it will not be replaced or logged off.");
      const instanceId = randomUUID(), suffix = createHash("sha256").update(instanceId).digest("hex").slice(0, 16);
      const directory = join(context.journalDirectory, "anode-" + suffix);
      const d: Data = { channel: "mcp-relay-" + suffix, agentId: "relay-" + suffix, stateFile: join(directory, "guardian.json"),
        runtimeExe: dep.runtimePath(), instanceId, parentSession: native.parentSession, brokerPid: process.pid,
        brokerStarted: native.brokerStarted, expiresAt: Math.min(options.expiresAt, options.hardExpiresAt), hardExpiresAt: options.hardExpiresAt,
        sequence: 1, phase: "preparing", revocationPath: context.revocationPath, width: options.width, height: options.height,
        interactiveSignIn: options.interactiveSignIn === true };
      const resource: WorkspaceResource = { providerId: ID, leaseId: options.leaseId, instanceId,
        display: { id: "windows-child:" + suffix, instanceId, x: 0, y: 0, width: options.width, height: options.height,
          scaleX: 1, scaleY: 1, primary: true, name: "Isolated Windows child session" }, data: d as unknown as JsonObject };
      await context.checkpoint(resource);
      await assertCreating(resource, context);
      await dep.native({ op: "protect", directory }, context);
      const guardianPath = join(directory, "guardian.ps1"), ownerPath = join(directory, "owner.ps1");
      const launcherPath = join(directory, "hidden-launcher.vbs");
      await dep.writeHelpers(directory);
      await save(resource, context);
      await assertCreating(resource, context);
      await dep.native({ op: "launch", taskName: "McpRelay-WorkspaceGuardian-" + suffix, executable: windowsScriptHost(),
        arguments: ["//B", "//Nologo", launcherPath, ...hiddenPowerShellArguments(guardianPath, d.stateFile)],
        parentSession: d.parentSession }, context);
      // A real Task Scheduler launch keeps Anode and its guardian outside relay /T trees.
      // No fallback to Process.Start, setup, configure, credential policy or physical input.
      let refreshFailure: unknown;
      let refreshing = Promise.resolve();
      const heartbeat = setInterval(() => {
        refreshing = refreshing.then(async () => {
          if (d.phase !== "preparing") return;
          await assertCreating(resource, context);
          d.sequence++; await save(resource, context);
        }).catch(error => { refreshFailure = error; });
      }, 2000);
      try {
        const guardianDeadline = Math.min(dep.now() + 12000, d.expiresAt, d.hardExpiresAt);
        let guardianReady = false;
        while (dep.now() < guardianDeadline) {
          await assertCreating(resource, context);
          const receipt = await dep.readArtifact(d.stateFile + ".guardian-ready.json");
          if (receipt?.instanceId === instanceId) {
            const checked = await dep.native({ op: "guardian-check", stateFile: d.stateFile }, context);
            if (checked.ready === true) { guardianReady = true; break; }
          }
          if (refreshFailure) throw refreshFailure;
          await delay(100, undefined, { signal: context.signal });
        }
        if (!guardianReady) throw new ComputerError("WORKSPACE_GUARDIAN_UNAVAILABLE", "The independent, hidden workspace guardian did not start; no child session was created.");
        await assertCreating(resource, context);
        await context.checkpoint(resource);
        await dep.native({ op: "launch", taskName: "McpRelay-WorkspaceOwner-" + suffix, executable: windowsScriptHost(),
          arguments: ["//B", "//Nologo", launcherPath, ...hiddenPowerShellArguments(ownerPath, d.stateFile)],
          parentSession: d.parentSession }, context);
        const startDeadline = Math.min(dep.now() + 120000, d.expiresAt, d.hardExpiresAt);
        let ready: Record<string, unknown> | undefined;
        while (dep.now() < startDeadline) {
          if (refreshFailure) throw refreshFailure;
          await assertCreating(resource, context);
          const ownerError = await dep.readArtifact(d.stateFile + ".owner-error.json");
          if (ownerError) throw new ComputerError("WORKSPACE_START_FAILED", String(ownerError.error ?? "The hidden workspace owner failed to start."));
          if (await dep.readRecovery(d.stateFile)) throw new ComputerError("WORKSPACE_HANDED_OFF", "The native guardian ended workspace creation.");
          try {
            const value = await dep.request(d.channel, { op: "status", agentId: d.agentId },
              { ...context, timeoutMs: Math.min(3000, context.timeoutMs) });
            if (value.channel !== d.channel || value.parentSession !== d.parentSession)
              throw new ComputerError("WORKSPACE_IDENTITY_CHANGED", "The Anode parent-session identity did not match.");
            if (value.state === "detached" || !d.interactiveSignIn && ["error", "logon-error"].includes(String(value.state))) throw new ComputerError("WORKSPACE_SIGN_IN_REQUIRED",
              String(value.lastError ?? "Windows could not automatically sign into its child session. Interactive native sign-in may be required."));
            if (value.state === "ready") { validateAnodeStatus(value, resource); display(resource, value); ready = value; break; }
          } catch (error) {
            if (!(error instanceof ComputerError) || error.code !== "WORKSPACE_UNAVAILABLE") throw error;
          }
          await delay(400, undefined, { signal: context.signal });
        }
        if (!ready) throw new ComputerError("WORKSPACE_START_TIMEOUT", "The child session did not become ready before its authorized deadline.");
        d.childSession = ready.session as number; d.seatPid = object(ready.seat)!.pid as number;
        // The only visible sign-in UI belongs to this explicitly opted-in open.
        // Once authenticated, hide its viewer before any agent lease exists.
        if (d.interactiveSignIn) await dep.request(d.channel, { op: "seat.hide" }, context);
        await save(resource, context);
        await assertCreating(resource, context);
        // The native acquisition shares the permanent create/recover fence. Its
        // private token receipt survives a broker crash before checkpoint.
        const lease = await dep.native({ op: "lease-acquire", stateFile: d.stateFile }, context);
        if (lease.ownerAgentId !== d.agentId || typeof lease.leaseToken !== "string" || lease.leaseToken.length > 128)
          throw new ComputerError("WORKSPACE_LEASE_REJECTED", "Anode did not grant this workspace its own native lease.");
        await assertCreating(resource, context);
        d.leaseToken = lease.leaseToken; d.phase = "active"; d.sequence++;
        await refreshing; await save(resource, context);
        if (options.launch) await ownedRequest(resource, { op: "run", path: options.launch.executable, args: options.launch.args,
          cwd: win32.dirname(options.launch.executable) }, context);
        return resource;
      } finally { clearInterval(heartbeat); await refreshing; }
    },
    async renew(resource, expiresAt, context) {
      const d = await guard(resource, context);
      const next = Math.min(expiresAt, d.hardExpiresAt);
      if (!Number.isFinite(next) || next <= dep.now()) throw new ComputerError("WORKSPACE_LEASE_EXPIRED", "The workspace authorization has expired.");
      // Renewal uses the runtime's independent lease channel, so a long capture/input cannot delay the guardian heartbeat.
      await dep.request(d.channel, { op: "lease", action: "renew", agentId: d.agentId, leaseToken: d.leaseToken, ttlSeconds: 10,
        clientPid: d.brokerPid, clientStarted: d.brokerStarted }, { ...context, timeoutMs: Math.min(context.timeoutMs, 3000) });
      await guard(resource, context);
      d.expiresAt = next; d.sequence++; await save(resource, context);
    },
    async inspect(resource, context) {
      const value = await status(resource, context), d = data(resource);
      return { platform: "win32", backend: ID, available: true, displayKind: "virtual", inputKind: "mouse_keyboard",
        displays: [display(resource, value)], actions: [...ACTIONS], unicodeText: true,
        permissions: { interactiveDesktop: "granted", screenCapture: "granted", input: "granted" },
        details: { parentSession: d.parentSession, childSession: d.childSession, pointerGuard: value.pointerGuard,
          recovery: "handoff-viewer", clipboardRedirection: false, securitySandbox: false } };
    },
    async capture(resource, context) {
      await status(resource, context);
      const shot = await ownedRequest(resource, { op: "screenshot", maxWidth: resource.display.width, format: "png" }, context);
      if (shot.mimeType !== "image/png" || typeof shot.data !== "string" || shot.data.length > 32 * 1024 * 1024)
        throw new ComputerError("WORKSPACE_CAPTURE_FAILED", "Anode did not return a bounded PNG screenshot.");
      const bytes = Buffer.from(shot.data, "base64"), size = pngDimensions(bytes);
      if (size.width !== resource.display.width || size.height !== resource.display.height
        || shot.sourceWidth !== resource.display.width || shot.sourceHeight !== resource.display.height)
        throw new ComputerError("WORKSPACE_DISPLAY_CHANGED", "The child screenshot size changed; no coordinates were accepted.");
      return { data: bytes, mimeType: "image/png", display: resource.display, capturedAt: dep.now() };
    },
    async act(resource, action, context) {
      const requests = mapAnodeAction(resource, action);
      await status(resource, context);
      let result: Record<string, unknown> = {};
      for (const request of requests) result = await ownedRequest(resource, request, context);
      return { ...result, submitted: true, isolatedSession: data(resource).childSession,
        verification: "The verified child-session runtime accepted the input. Capture a fresh frame to verify the application outcome." };
    },
    async recover(resource, _options, reason, context) {
      if (!resource) return { complete: true, outcome: "no-resources", inputRevoked: true, ownedDisplayRemoved: true };
      const d = data(resource);
      // This local permanent marker also protects standalone/manual recovery.
      try { await dep.revoke(d.stateFile + ".revoked.json", reason); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // An ownership intent may have been checkpointed before its directory
        // was created. The permanent common marker already fences late open.
        await dep.native({ op: "protect", directory: win32.dirname(d.stateFile) }, context);
        await dep.revoke(d.stateFile + ".revoked.json", reason);
      }
      d.phase = "handoff"; d.closeReason = reason; d.sequence++;
      await save(resource, context);
      const previous = await dep.readRecovery(d.stateFile);
      if (previous?.complete === true && previous.inputRevoked === true
          && ["handoff-viewer", "no-resources"].includes(String(previous.outcome)))
        return { complete: true, outcome: previous.outcome as "handoff-viewer" | "no-resources",
          inputRevoked: true, ownedDisplayRemoved: previous.ownedDisplayRemoved === true, details: previous };
      try {
        const result = await dep.native({ op: "recover", stateFile: d.stateFile, reason }, context);
        const complete = result.complete === true && result.inputRevoked === true
          && ["handoff-viewer", "no-resources"].includes(String(result.outcome));
        return { complete, outcome: complete ? result.outcome as "handoff-viewer" | "no-resources" : "cleanup-pending",
          inputRevoked: result.inputRevoked === true, ownedDisplayRemoved: result.ownedDisplayRemoved === true,
          details: result };
      } catch (error) {
        return { complete: false, outcome: "cleanup-pending", inputRevoked: false, ownedDisplayRemoved: false,
          details: { appsPreserved: true, guardianWillRetry: true, reason: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
