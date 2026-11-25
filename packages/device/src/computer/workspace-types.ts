import type { JsonObject } from "@mcp-relay/shared";
import type { CapturedScreen, ComputerAction, ComputerDisplay, ComputerState, NativeContext } from "./types.js";

export type WorkspacePhase = "preparing" | "active" | "restoring" | "cleanup_pending" | "closed";
export type WorkspaceCloseReason = "explicit" | "expired" | "authorization_expired" | "disconnected" | "owner_lost" | "disabled" | "recovery" | "open_failed";

/** Server-authenticated identity, never supplied by a tool argument. */
export interface WorkspaceOwner {
  ownerKey: string;
  authorizationExpiresAt: number;
  connectionEpoch: string;
}
export interface WorkspaceOpenOptions {
  leaseId: string;
  width: number;
  height: number;
  /** Windows-only explicit opt-in to show the owned native OS sign-in UI; default false. */
  interactiveSignIn?: boolean;
  /** Only explicitly selected windows; providers must refuse unsupported adoption. */
  windowIds?: string[];
  /** Launch directly in the private session; never through a shell. */
  launch?: { executable: string; args: string[] };
  /** Absolute maximum bound; helper must additionally implement its own monotonic expiry. */
  expiresAt: number;
  hardExpiresAt: number;
}
export interface WorkspaceCapabilities {
  available: boolean;
  reason?: string;
  /** True only when screen, keyboard, pointer and focus avoid the physical input session. */
  isolated: boolean;
  /** App state boundary, separate from foreground input isolation; tools never change physical clipboard/IME. */
  clipboardBoundary: "isolated" | "shared-app-state" | "unsupported";
  canAdoptWindows: boolean;
  recovery: "window-moved" | "handoff-viewer" | "unsupported";
  independentWatchdog: boolean;
  unicodeText: boolean;
  details?: Record<string, unknown>;
}
/** Durable, bounded JSON sufficient to recover solely this lease's resources. */
export interface WorkspaceResource {
  providerId: string;
  leaseId: string;
  instanceId: string;
  display: ComputerDisplay;
  data: JsonObject;
}
export interface WorkspaceRecoveryResult {
  complete: boolean;
  outcome: "window-moved" | "handoff-viewer" | "no-resources" | "cleanup-pending";
  /** Applications remain available; returned viewers accept no agent input after handoff. */
  inputRevoked: boolean;
  ownedDisplayRemoved: boolean;
  details?: Record<string, unknown>;
}
export interface WorkspaceProviderContext extends NativeContext {
  /** Private lease directory; no bearer credentials. */
  journalDirectory: string;
  /** Permanent atomic marker written before recovery; launchers and native helpers must fence late creation/input against it. */
  revocationPath: string;
  /** Must be awaited before each external resource mutation; include an ownership intent first. */
  checkpoint(resource: WorkspaceResource): Promise<void>;
}

/** Runs inside the independent broker, never in a per-action disposable helper. */
export interface WorkspaceProvider {
  readonly id: string;
  /** Explicit setup only; probe/open must not download software or grant permissions. */
  setup?(context: NativeContext): Promise<Record<string, unknown>>;
  probe(context: NativeContext): Promise<WorkspaceCapabilities>;
  open(options: WorkspaceOpenOptions, context: WorkspaceProviderContext): Promise<WorkspaceResource>;
  /** Called every 2 seconds with the current absolute deadline as a liveness heartbeat.
   * Repeated expiresAt must not extend the native monotonic TTL; only explicit renew changes it. */
  renew(resource: WorkspaceResource, expiresAt: number, context: WorkspaceProviderContext): Promise<void>;
  inspect(resource: WorkspaceResource, context: NativeContext): Promise<ComputerState>;
  capture(resource: WorkspaceResource, context: NativeContext): Promise<CapturedScreen>;
  act(resource: WorkspaceResource, action: ComputerAction, context: NativeContext): Promise<Record<string, unknown>>;
  /** Idempotent, including a partially-created resource recorded before open completed. */
  recover(resource: WorkspaceResource | undefined, options: WorkspaceOpenOptions,
    reason: WorkspaceCloseReason, context: WorkspaceProviderContext): Promise<WorkspaceRecoveryResult>;
}

export interface WorkspaceTransport {
  epoch: string;
  authenticated: boolean;
  signal: AbortSignal;
  /** Updated only by a real message from the authenticated device WebSocket. */
  lastServerMessageAt(): number;
}
export interface WorkspaceCallIdentity {
  ownerKey: string;
  authorizationExpiresAt: number;
}
