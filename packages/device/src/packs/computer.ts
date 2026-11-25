import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_NATIVE_IMAGE_BYTES, type CallToolResult, type JsonObject, type ToolDescriptor } from "@mcp-relay/shared";
import { jsonResult, type PackContext, type ToolPack } from "../pack.js";
import { acquireUpdateLock } from "../updater.js";
import { createAndroidBackend } from "../computer/android.js";
import { createLinuxHostBackend } from "../computer/linux-host.js";
import { createMacosBackend } from "../computer/macos.js";
import { createWindowsBackend } from "../computer/windows.js";
import { pngDimensions } from "../computer/native.js";
import { ComputerError, type ComputerAction, type ComputerBackend, type ComputerDisplay,
  type CapturedScreen, type NativeContext } from "../computer/types.js";
import { WorkspaceManager } from "../computer/workspace-client.js";
import { readComputerSettings, writeComputerSettings, type ComputerSettings } from "../computer/settings.js";

const timeout = z.number().int().min(1).max(120000).optional();
const coordinate = z.number().int().min(0).max(32767);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal("click"), x: coordinate, y: coordinate,
    button: z.enum(["left", "right", "middle"]).optional(), clicks: z.number().int().min(1).max(3).optional() }).strict(),
  z.object({ type: z.literal("drag"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate,
    durationMs: z.number().int().min(100).max(5000).optional() }).strict(),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(40).optional().describe("Number of scroll steps (1–40); defaults to 3."), x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z.object({ type: z.literal("key"), keys: z.array(z.string().min(1).max(48)).min(1).max(8) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().max(16384) }).strict()
]);
const infoSchema = z.object({ workspace: z.boolean().optional(), timeout_ms: timeout }).strict();
const leaseId = z.string().uuid().optional();
const inspectSchema = z.object({ lease_id: leaseId, display_id: z.string().min(1).max(200).optional(), timeout_ms: timeout }).strict();
const screenshotSchema = z.object({ lease_id: leaseId, display_id: z.string().min(1).max(200).optional(), timeout_ms: timeout }).strict();
const inputSchema = z.object({
  lease_id: leaseId,
  request_id: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
  frame_id: z.string().min(1).max(200),
  action: actionSchema, screenshot_after: z.boolean().optional(), timeout_ms: timeout
}).strict();
const handoffSchema = z.object({ mode: z.enum(["pause", "resume"]), timeout_ms: timeout }).strict();

const requestIdSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);
const sessionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("open"), request_id: requestIdSchema, mode: z.literal("isolated"),
    width: z.number().int().min(320).max(8192).optional(), height: z.number().int().min(240).max(8192).optional(),
    idle_timeout_ms: z.number().int().min(1000).max(300000).optional(),
    max_duration_ms: z.number().int().min(1000).max(86400000).optional(),
    interactive_sign_in: z.boolean().optional().describe("Windows only: explicitly show the owned native Windows sign-in UI for the user to authenticate. Default false; no input is permitted until ready. Use timeout_ms:120000 when waiting for user sign-in."),
    window_ids: z.array(z.string().min(1).max(200)).max(32).optional(),
    launch: z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(16384)).max(64) }).strict().optional(),
    timeout_ms: timeout }).strict(),
  z.object({ operation: z.literal("renew"), lease_id: z.string().uuid(), request_id: requestIdSchema,
    extend_ms: z.number().int().min(1000).max(300000).optional(), timeout_ms: timeout }).strict(),
  z.object({ operation: z.literal("close"), lease_id: z.string().uuid(), request_id: requestIdSchema, timeout_ms: timeout }).strict(),
  z.object({ operation: z.literal("status"), lease_id: leaseId, timeout_ms: timeout }).strict()
]);

function descriptor(name: string, description: string, schema: z.ZodType, readOnly: boolean): ToolDescriptor {
  const inputSchema = z.toJSONSchema(schema) as JsonObject;
  delete inputSchema.$schema;
  return { name, description, inputSchema, annotations: { readOnlyHint: readOnly } };
}
const tools: ToolDescriptor[] = [
  descriptor("computer_session", "Open, renew, close or inspect a leased isolated computer workspace. To operate the user foreground instead, use the existing screenshot/action tools without lease_id; no workspace is required. Isolated mode never falls back to the physical desktop. Explicit renewals keep the lease alive; disconnection, expiry or lost owner starts independent recovery. Close returns windows or a user-controlled viewer and revokes agent input. Requires an updated relay server and an installed platform provider.", sessionSchema, false),
  descriptor("computer_info", "For foreground-safe control, open computer_session with mode isolated and pass its lease_id to info, screenshot and action. Inspect desktop and local PVE VM console availability, input capabilities, permissions, and pause state. On a PVE host, choose display_id pve:<VMID> to inspect that VM's actual console; omit it to discover targets. Does not start VMs, grant permissions, or install software.", inspectSchema, true),
  descriptor("computer_screenshot", "With lease_id, capture only that isolated workspace; a closed/unavailable lease never falls back to the physical display. Choose foreground observation by omitting lease_id to observe the host screen or a selected PVE VM console as a native PNG image. Use display_id from computer_info (pve:<VMID> for a VM). Returns frame_id and dimensions; all action coordinates are pixels of this exact image. Capture a fresh frame after changes.", screenshotSchema, true),
  descriptor("computer_action", "Choose foreground input by omitting lease_id and capturing a foreground frame. Choose isolated input by passing the same lease_id used to capture its frame_id. A mismatched frame or lease is rejected. Perform one bounded mouse/touch/keyboard/text action on a fresh frame. Requires write scope. Use a unique request_id; retrying the same ID never replays input in this worker. Unknown outcomes require a new screenshot before continuing. Text inserts text without pressing Enter.", inputSchema, false),
  descriptor("computer_handoff", "Pause or resume this device's computer control. Pause persists across updates. Wayland closes its portal permission session on pause; resume and run computer_setup before taking a new frame. Other foreground screenshots remain available while paused. Resume requires fresh screenshots.", handoffSchema, false),
  descriptor("computer_setup", "Explicitly set up the platform input bridge. On Wayland, request a desktop-approved monitor and keyboard/pointer session in this connected worker; use timeout_ms:120000 to allow local consent. Inspect and screenshots never prompt. Set workspace:true for the isolated workspace runtime; this never changes the physical clipboard or IME. Legacy Android setup installs its bundled Unicode IME. OS permission or su prompts require local approval; lock screens and permission dialogs remain enforced.", infoSchema, false)
];
type Frame = { display: ComputerDisplay; capturedAt: number; appId?: string; leaseId?: string; connectionEpoch?: string; ownerKey?: string };
type Cached = { fingerprint: string; result: CallToolResult };

export interface ComputerPackOptions {
  configPath: string;
  defaultEnabled?: boolean;
  backend?: ComputerBackend;
  now?: () => number;
  lock?: () => Promise<() => Promise<void>>;
  settings?: () => ComputerSettings;
  workspaceManager?: Pick<WorkspaceManager, "capabilities" | "setup" | "session" | "inspect" | "capture" | "act" | "updateBlockedReason" | "revokeOwner" | "closeAll" | "dispose">;
  saveSettings?: (change: Partial<Pick<ComputerSettings, "enabled" | "paused">>) => ComputerSettings;
}

export function selectComputerBackend(platform: NodeJS.Platform = process.platform): ComputerBackend {
  switch (platform) {
    case "win32": return createWindowsBackend();
    case "darwin": return createMacosBackend();
    case "android": return createAndroidBackend();
    case "linux": return createLinuxHostBackend();
    default: throw new ComputerError("unsupported_platform", "Computer control is unsupported on " + platform + ".");
  }
}

function geometry(display: ComputerDisplay): string {
  return JSON.stringify([display.id, display.instanceId, display.x, display.y, display.width, display.height,
    display.scaleX ?? 1, display.scaleY ?? 1, display.rotation ?? 0]);
}
function checkPoint(display: ComputerDisplay, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= display.width || y >= display.height) {
    throw new ComputerError("coordinate_out_of_bounds", "Coordinates must be inside the referenced screenshot.");
  }
}
function checkAction(action: ComputerAction, display: ComputerDisplay): void {
  if (action.type === "move" || action.type === "click") checkPoint(display, action.x, action.y);
  if (action.type === "drag") {
    checkPoint(display, action.fromX, action.fromY); checkPoint(display, action.toX, action.toY);
  }
  if (action.type === "scroll") {
    if ((action.x === undefined) !== (action.y === undefined)) {
      throw new ComputerError("invalid_coordinates", "Scroll requires both x and y, or neither.");
    }
    if (action.x !== undefined && action.y !== undefined) checkPoint(display, action.x, action.y);
  }
  if (action.type === "text" && (Buffer.byteLength(action.text, "utf8") > 65536 || action.text.includes("\0"))) {
    throw new ComputerError("invalid_text", "Text must contain at most 64 KiB of UTF-8 and no NUL.");
  }
}
function errorResult(error: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  if (error instanceof Error && error.name === "AbortError") {
    error = new ComputerError("cancelled", "Computer operation was cancelled.");
  }
  const known = error instanceof ComputerError ? error : undefined;
  const detail = known?.details;
  const value = { ok: false, code: known ? known.code : error instanceof z.ZodError ? "invalid_arguments" : "computer_failed",
    message: known ? known.message : error instanceof z.ZodError ? "Invalid computer tool arguments." : "Computer operation failed.",
    ...(detail ?? {}), ...extra };
  return { ...jsonResult(value), isError: true };
}

export function createComputerPack(options: ComputerPackOptions): ToolPack {
  const backend = options.backend ?? selectComputerBackend();
  const workspaces = options.workspaceManager ?? new WorkspaceManager({ configPath: options.configPath });
  const now = options.now ?? Date.now;
  const settings = options.settings ?? (() => readComputerSettings(options.configPath, options.defaultEnabled));
  const saveSettings = options.saveSettings ?? (change => writeComputerSettings(options.configPath, change, options.defaultEnabled));
  const lock = options.lock ?? (() => acquireUpdateLock(join(homedir(), ".mcp-relay", "computer-control"), "desktop"));
  const frames = new Map<string, Frame>();
  const receipts = new Map<string, Cached>();
  const generation = randomUUID();
  let busy = false;
  let activeAbort: AbortController | undefined;
  let permissionSettings: { revision?: string } | undefined;
  let permissionMonitor: ReturnType<typeof setInterval> | undefined;

  async function closePermissionSession(): Promise<void> {
    permissionSettings = undefined;
    if (permissionMonitor) clearInterval(permissionMonitor);
    permissionMonitor = undefined;
    frames.clear();
    await backend.close?.();
  }
  async function checkPermissionSettings(): Promise<void> {
    if (!permissionSettings) return;
    try {
      const current = settings();
      if (current.enabled && !current.paused && current.revision === permissionSettings.revision) return;
    } catch { /* unreadable settings revoke the permission session */ }
    await closePermissionSession();
  }
  function watchPermissionSettings(): { revision?: string } {
    if (permissionMonitor) clearInterval(permissionMonitor);
    const stamp = { revision: settings().revision };
    permissionSettings = stamp;
    // Local computer-pause/disable must also close an idle permission session.
    // A revision change catches a pause/resume pair between two observations.
    permissionMonitor = setInterval(() => { void checkPermissionSettings().catch(() => {}); }, 100);
    permissionMonitor.unref();
    return stamp;
  }

  const remember = (id: string, fingerprint: string, result: CallToolResult) => {
    receipts.set(id, { fingerprint, result });
    while (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
  };
  const enabled = () => {
    const current = settings();
    if (!current.enabled) {
      void closePermissionSession().catch(() => {});
      throw new ComputerError("computer_disabled",
        "Computer control is disabled. Enable it locally with mcp-relay computer-enable --config <path>.");
    }
    return current;
  };
  async function capture(displayId: string | undefined, ctx: NativeContext, workspaceId?: string, packCtx?: PackContext): Promise<CallToolResult> {
    enabled();
    const screen: CapturedScreen = workspaceId
      ? await workspaces.capture(workspaceId, packCtx!, ctx) : await backend.screenshot(displayId, ctx);
    if (workspaceId && displayId && screen.display.id !== displayId) throw new ComputerError("workspace_display_mismatch", "Requested display is not owned by this isolated workspace.");
    const dimensions = pngDimensions(screen.data);
    if (![screen.display.x, screen.display.y].every(Number.isFinite)
      || ![screen.display.scaleX ?? 1, screen.display.scaleY ?? 1].every(n => Number.isFinite(n) && n > 0)) {
      throw new ComputerError("invalid_screenshot_geometry", "Native helper returned an invalid input coordinate transform.");
    }
    if (screen.data.length > MAX_NATIVE_IMAGE_BYTES) throw new ComputerError("screenshot_too_large", "Screenshot exceeds 12 MiB.");
    if (dimensions.width !== screen.display.width || dimensions.height !== screen.display.height) {
      throw new ComputerError("invalid_screenshot_geometry", "Screenshot dimensions do not match the input coordinate space.");
    }
    if (!Number.isFinite(screen.capturedAt) || screen.capturedAt > now() + 5000) {
      throw new ComputerError("invalid_screenshot_time", "Native helper returned an invalid capture timestamp.");
    }
    for (const [id, frame] of frames) if (now() - frame.capturedAt > 120000) frames.delete(id);
    const frameId = generation + ":" + randomUUID();
    frames.set(frameId, { display: { ...screen.display }, capturedAt: screen.capturedAt,
      ...(screen.app?.id ? { appId: screen.app.id } : {}),
      ...(workspaceId ? { leaseId: workspaceId, connectionEpoch: packCtx?.connection?.epoch, ownerKey: packCtx?.caller?.ownerKey } : {}) });
    while (frames.size > 12) frames.delete(frames.keys().next().value!);
    const metadata = { ok: true, frame_id: frameId, captured_at: new Date(screen.capturedAt).toISOString(),
      expires_in_ms: Math.max(0, 120000 - (now() - screen.capturedAt)), coordinate_space: "screenshot_pixels",
      ...(workspaceId ? { lease_id: workspaceId } : {}),
      display: screen.display, ...(screen.app ? { app: screen.app } : {}), paused: settings().paused };
    return { content: [{ type: "image", mimeType: "image/png", data: screen.data.toString("base64") },
      { type: "text", text: JSON.stringify(metadata) }], structuredContent: metadata };
  }

  return {
    id: "computer",
    tools,
    updateBlockedReason: () => workspaces.updateBlockedReason(),
    connectionClosed: () => { void closePermissionSession().catch(() => {}); },
    revokeWorkspaceOwner: async ownerKey => {
      await Promise.all([closePermissionSession(), workspaces.revokeOwner(ownerKey)]);
    },
    dispose: async () => { await Promise.all([closePermissionSession(), workspaces.dispose()]); },
    async call(name: string, args: JsonObject, packCtx: PackContext): Promise<CallToolResult> {
      let release: (() => Promise<void>) | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let monitor: ReturnType<typeof setInterval> | undefined;
      let occupied = false;
      let requestId: string | undefined, fingerprint: string | undefined;
      let attempted = false;
      let actionType: string | undefined;
      const startedAt = now();
      try {
        const parsed = name === "computer_session" ? sessionSchema.parse(args)
          : name === "computer_action" ? inputSchema.parse(args)
          : name === "computer_screenshot" ? screenshotSchema.parse(args)
          : name === "computer_handoff" ? handoffSchema.parse(args)
          : name === "computer_info" ? inspectSchema.parse(args)
          : name === "computer_setup" ? infoSchema.parse(args)
          : undefined;
        if (!parsed) throw new ComputerError("unknown_tool", "Unknown computer tool.");
        const timeoutMs = parsed.timeout_ms ?? (name === "computer_session" && "interactive_sign_in" in parsed && parsed.interactive_sign_in === true ? 120000 : 30000);
        const controller = new AbortController();
        deadline = setTimeout(() => controller.abort(new ComputerError("timeout", "Computer operation exceeded its deadline.")), timeoutMs);
        const signal = packCtx.signal ? AbortSignal.any([packCtx.signal, controller.signal]) : controller.signal;
        const context = (): NativeContext => ({ signal, timeoutMs: Math.max(1, Math.min(120000, timeoutMs - (now() - startedAt))) });
        signal.throwIfAborted();
        await checkPermissionSettings();
        signal.throwIfAborted();

        if (name === "computer_info" && !settings().enabled) {
          await closePermissionSession();
          return jsonResult({ enabled: false, paused: settings().paused, backend: backend.id, generation });
        }
        enabled();
        if (name === "computer_session") {
          const input = sessionSchema.parse(parsed);
          if (settings().paused && (input.operation === "open" || input.operation === "renew")) throw new ComputerError("computer_paused", "Resume computer control before opening or renewing a workspace.");
          if (input.operation === "close") frames.clear();
          return jsonResult(await workspaces.session(input, { ...packCtx, signal }));
        }
        if (name === "computer_handoff") {
          const input = handoffSchema.parse(parsed);
          saveSettings({ paused: input.mode === "pause" });
          frames.clear();
          if (input.mode === "pause") {
            activeAbort?.abort(new ComputerError("handoff", "Computer control was paused."));
            await Promise.all([closePermissionSession(), workspaces.closeAll("disabled")]);
          }
          return jsonResult({ ok: true, enabled: true, paused: input.mode === "pause", requires_new_frame: true });
        }
        if (name === "computer_action") {
          const input = inputSchema.parse(parsed);
          requestId = input.request_id; actionType = input.action.type;
          fingerprint = createHash("sha256").update(JSON.stringify({
            lease_id: input.lease_id, ...(input.lease_id ? { owner: packCtx.caller?.ownerKey, epoch: packCtx.connection?.epoch } : {}), frame_id: input.frame_id, action: input.action, screenshot_after: input.screenshot_after ?? false
          })).digest("hex");
          const cached = receipts.get(requestId);
          if (cached) {
            if (cached.fingerprint !== fingerprint) throw new ComputerError("request_id_conflict",
              "This request_id was already used with different arguments.");
            return { ...cached.result, content: [...cached.result.content, { type: "text",
              text: "Cached receipt: input was not replayed. Request a fresh screenshot to observe current state." }] };
          }
          if (settings().paused) throw new ComputerError("computer_paused", "Computer control is paused. Resume explicitly before acting.");
        }
        if (busy) throw new ComputerError("computer_busy", "Another computer operation is in progress.");
        busy = true; occupied = true; activeAbort = controller;
        try { release = await lock(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "UPDATE_LOCK_BUSY") {
            throw new ComputerError("computer_busy", "Another relay process is using this desktop.");
          }
          throw error;
        }
        signal.throwIfAborted();
        monitor = setInterval(() => {
          try {
            const current = settings();
            if (!current.enabled || ((name === "computer_action" || name === "computer_setup") && current.paused)) {
              controller.abort(new ComputerError("handoff", "Computer control was disabled or paused."));
            }
          } catch { controller.abort(new ComputerError("computer_disabled", "Computer settings could not be read.")); }
        }, 100);
        if (name === "computer_info") {
          const input = inspectSchema.parse(parsed);
          const state = input.lease_id ? await workspaces.inspect(input.lease_id, packCtx, context()) : await backend.inspect(context(), input.display_id);
          if (input.lease_id && input.display_id && !state.displays.some(display => display.id === input.display_id)) throw new ComputerError("workspace_display_mismatch", "Display is not owned by this workspace.");
          return jsonResult({ ...state, enabled: true, paused: settings().paused,
            ...(!input.lease_id ? { workspace: await workspaces.capabilities(context()) } : { lease_id: input.lease_id }),
            generation, frame_ttl_ms: 120000, limits: { screenshot_bytes: MAX_NATIVE_IMAGE_BYTES, text_utf8_bytes: 65536 } });
        }
        if (name === "computer_screenshot") {
          const input = screenshotSchema.parse(parsed);
          return await capture(input.display_id, context(), input.lease_id, packCtx);
        }
        if (name === "computer_setup") {
          if (settings().paused) throw new ComputerError("computer_paused", "Resume computer control before setup.");
          frames.clear();
          if (infoSchema.parse(parsed).workspace) return jsonResult({ ok: true, ...await workspaces.setup(context()) });
          const stamp = backend.setupInWorker ? watchPermissionSettings() : undefined;
          try {
            const result = backend.setup ? await backend.setup(context()) : {
              state: await backend.inspect(context()), automaticInstall: false
            };
            await checkPermissionSettings();
            signal.throwIfAborted();
            if (stamp && permissionSettings !== stamp) throw new ComputerError("computer_paused",
              "Computer settings changed during setup. Resume control and request a new permission session.");
            return jsonResult({ ok: true, ...result });
          } catch (error) {
            if (stamp) await closePermissionSession();
            throw error;
          }
        }
        const input = inputSchema.parse(parsed);
        const frame = frames.get(input.frame_id);
        if (!frame || now() - frame.capturedAt > 120000) {
          throw new ComputerError("stale_frame", "Unknown or expired frame. Capture a fresh screenshot before acting.");
        }
        if (frame.leaseId !== input.lease_id || (frame.leaseId && (frame.connectionEpoch !== packCtx.connection?.epoch || frame.ownerKey !== packCtx.caller?.ownerKey))) throw new ComputerError("workspace_frame_mismatch", "Frame belongs to a different workspace or connection.");
        checkAction(input.action, frame.display);
        const state = frame.leaseId
          ? await workspaces.inspect(frame.leaseId, packCtx, { ...context(), expectedAppId: frame.appId })
          : await backend.inspect({ ...context(), expectedAppId: frame.appId }, frame.display.id);
        if (!state.available) throw new ComputerError("desktop_unavailable", state.reason ?? "Desktop is unavailable.");
        if (!state.actions.includes(input.action.type)) {
          throw new ComputerError("unsupported_action", "This device does not support action " + input.action.type + ".");
        }
        const current = state.displays.find(display => display.id === frame.display.id);
        if (!current || geometry(current) !== geometry(frame.display)) {
          frames.clear();
          throw new ComputerError("display_changed", "Display geometry or rotation changed. Capture a fresh screenshot.");
        }
        if (frame.appId && state.app?.id && frame.appId !== state.app.id) {
          frames.clear();
          throw new ComputerError("focus_changed", "The active application changed since the screenshot. Observe it again before acting.");
        }
        signal.throwIfAborted();
        if (settings().paused) throw new ComputerError("computer_paused", "Computer control is paused.");
        frames.clear(); // Consume all pre-action observations, including on unknown outcomes.
        attempted = true;
        const outcome = frame.leaseId
          ? await workspaces.act(frame.leaseId, requestId!, input.action, packCtx, { ...context(), expectedAppId: frame.appId })
          : await backend.act(input.action, current, { ...context(), expectedAppId: frame.appId });
        const receipt = { ok: true, request_id: requestId, action: actionType,
          completed_at: new Date(now()).toISOString(), elapsed_ms: now() - startedAt,
          ...outcome, requires_new_frame: true };
        const result = jsonResult(receipt);
        remember(requestId!, fingerprint!, result);
        if (!input.screenshot_after) return result;
        try {
          const observed = await capture(current.id, context(), frame.leaseId, packCtx);
          return { content: [...result.content, ...observed.content],
            structuredContent: { receipt, observation: observed.structuredContent } };
        } catch (error) {
          return { ...jsonResult({ ...receipt, screenshot_error: error instanceof ComputerError ? error.code : "capture_failed" }),
            content: [...result.content, { type: "text", text: "Input completed; the follow-up screenshot failed. Do not repeat the input. Capture a fresh screenshot." }] };
        }
      } catch (error) {
        const result = errorResult(error, { ...(requestId ? { request_id: requestId, action: actionType } : {}),
          // Setup can mutate even though no computer_action was attempted.
          mayHaveApplied: attempted || (error instanceof ComputerError && error.details?.mayHaveApplied === true),
          requires_new_frame: attempted });
        if (attempted && requestId && fingerprint) remember(requestId, fingerprint, result);
        return result;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (monitor) clearInterval(monitor);
        await release?.();
        if (occupied) { busy = false; activeAbort = undefined; }
      }
    }
  };
}
