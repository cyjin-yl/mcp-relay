import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requiredScope, SCOPE_WRITE } from "@mcp-relay/shared";
import { createComputerPack, type ComputerPackOptions } from "../src/packs/computer.js";
import { WorkspaceManager } from "../src/computer/workspace-client.js";
import { ComputerError, type ComputerBackend, type ComputerState } from "../src/computer/types.js";
import type { PackContext } from "../src/pack.js";
import type { WorkspaceProvider } from "../src/computer/workspace-types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=", "base64");
function fixture() {
  const leaseId = randomUUID(), abort = new AbortController();
  const context: PackContext = { root: "/", allowShell: false, allowKernel: false, log() {},
    caller: { ownerKey: "authenticated-owner", authorizationExpiresAt: Date.now() + 60000 },
    connection: { epoch: "live-epoch", authenticated: true, signal: abort.signal, lastServerMessageAt: Date.now } };
  const display = { id: "private:lease", instanceId: leaseId, x: 0, y: 0, width: 1, height: 1 };
  const state: ComputerState = { platform: "linux", backend: "private", available: true, displayKind: "virtual",
    inputKind: "mouse_keyboard", displays: [display], actions: ["text", "click"], unicodeText: true,
    permissions: {}, app: { id: "private-app" } };
  const physical = vi.fn(async () => { throw new Error("physical backend must not be used"); });
  const backend: ComputerBackend = { id: "physical", inspect: physical, screenshot: physical, act: physical, setup: physical };
  const manager = {
    capabilities: vi.fn(async () => ({ available: true, isolated: true })),
    setup: vi.fn(async () => ({ installed: true })),
    session: vi.fn(async () => ({ lease_id: leaseId, state: "closed" })),
    inspect: vi.fn(async () => state),
    capture: vi.fn(async () => ({ data: png, mimeType: "image/png" as const, display, capturedAt: Date.now(), app: { id: "private-app" } })),
    act: vi.fn(async () => ({ applied: true })),
    updateBlockedReason: vi.fn(() => "isolated workspace active" as string | undefined),
    revokeOwner: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  } satisfies NonNullable<ComputerPackOptions["workspaceManager"]>;
  let paused = false;
  const pack = createComputerPack({ configPath: "/unused", backend, workspaceManager: manager,
    settings: () => ({ schema: 1, enabled: true, paused }),
    saveSettings: change => ({ schema: 1, enabled: true, paused: paused = change.paused ?? paused }),
    lock: async () => async () => {} });
  async function frame() {
    const result = await pack.call("computer_screenshot", { lease_id: leaseId }, context);
    expect(result.isError).not.toBe(true);
    return (result.structuredContent as Record<string, string>).frame_id!;
  }
  return { leaseId, abort, context, display, manager, physical, pack, frame };
}
const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, unknown>;

describe("computer workspace routing and ownership", () => {
  it("requires write scope for every workspace lifecycle call even when a device labels it read-only", () => {
    expect(requiredScope({ name: "computer_session", annotations: { readOnlyHint: true } })).toBe(SCOPE_WRITE);
    const f = fixture();
    expect(f.pack.tools.find(tool => tool.name === "computer_session")?.annotations?.readOnlyHint).toBe(false);
  });
  it("routes lease screenshots and actions exclusively to the private provider with the original app identity", async () => {
    const f = fixture(), frame_id = await f.frame();
    const result = await f.pack.call("computer_action", { lease_id: f.leaseId, frame_id,
      request_id: "private-text", action: { type: "text", text: "isolated" } }, f.context);
    expect(result.isError).not.toBe(true);
    expect(f.manager.inspect).toHaveBeenCalledWith(f.leaseId, f.context, expect.objectContaining({ expectedAppId: "private-app" }));
    expect(f.manager.act).toHaveBeenCalledWith(f.leaseId, "private-text", { type: "text", text: "isolated" },
      f.context, expect.objectContaining({ expectedAppId: "private-app" }));
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("refuses omitted or substituted lease IDs and frames from another owner or connection", async () => {
    const f = fixture(), frame_id = await f.frame();
    const action = { type: "click", x: 0, y: 0 };
    const variants = [
      { args: { frame_id, request_id: "missing", action }, ctx: f.context },
      { args: { lease_id: randomUUID(), frame_id, request_id: "other", action }, ctx: f.context },
      { args: { lease_id: f.leaseId, frame_id, request_id: "epoch", action }, ctx: { ...f.context, connection: { ...f.context.connection!, epoch: "new-epoch" } } },
      { args: { lease_id: f.leaseId, frame_id, request_id: "owner", action }, ctx: { ...f.context, caller: { ...f.context.caller!, ownerKey: "different-owner" } } }
    ];
    for (const value of variants) expect(data(await f.pack.call("computer_action", value.args, value.ctx)).code).toBe("workspace_frame_mismatch");
    expect(f.manager.act).not.toHaveBeenCalled(); expect(f.physical).not.toHaveBeenCalled();
  });

  it("does not expose a cached workspace receipt to a different caller", async () => {
    const f = fixture(), frame_id = await f.frame();
    const args = { lease_id: f.leaseId, frame_id, request_id: "receipt", action: { type: "text", text: "one" } };
    expect((await f.pack.call("computer_action", args, f.context)).isError).not.toBe(true);
    const other = { ...f.context, caller: { ...f.context.caller!, ownerKey: "different-owner" } };
    expect(data(await f.pack.call("computer_action", args, other)).code).toBe("request_id_conflict");
    expect(f.manager.act).toHaveBeenCalledTimes(1);
  });

  it("returns private-target errors without attempting a physical screenshot", async () => {
    const f = fixture();
    f.manager.capture.mockRejectedValueOnce(new ComputerError("workspace_closed", "Lease ended"));
    expect(data(await f.pack.call("computer_screenshot", { lease_id: f.leaseId }, f.context)).code).toBe("workspace_closed");
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("sets up isolated support explicitly without invoking the physical IME setup", async () => {
    const f = fixture();
    expect((await f.pack.call("computer_setup", { workspace: true }, f.context)).isError).not.toBe(true);
    expect(f.manager.setup).toHaveBeenCalledTimes(1); expect(f.physical).not.toHaveBeenCalled();
  });

  it("invalidates frames on disconnect, revocation and handoff and exposes the update gate", async () => {
    const f = fixture();
    expect(f.pack.updateBlockedReason?.()).toBe("isolated workspace active");
    const disconnected = await f.frame();
    f.pack.connectionClosed?.("live-epoch");
    expect(data(await f.pack.call("computer_action", { lease_id: f.leaseId, frame_id: disconnected,
      request_id: "disconnect", action: { type: "text", text: "no" } }, f.context)).code).toBe("stale_frame");
    const revoked = await f.frame();
    await f.pack.revokeWorkspaceOwner?.("authenticated-owner");
    expect(f.manager.revokeOwner).toHaveBeenCalledWith("authenticated-owner");
    expect(data(await f.pack.call("computer_action", { lease_id: f.leaseId, frame_id: revoked,
      request_id: "revoke", action: { type: "text", text: "no" } }, f.context)).code).toBe("stale_frame");
    await f.pack.call("computer_handoff", { mode: "pause" }, f.context);
    expect(f.manager.closeAll).toHaveBeenCalledWith("disabled");
    await f.pack.dispose?.(); expect(f.manager.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a revoked owner even when revocation arrives before open finishes probing", async () => {
    const f = fixture(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const launchBroker = vi.fn(async () => {});
    const manager = new WorkspaceManager({ configPath: join(mkdtempSync(join(tmpdir(), "workspace-revoke-")), "device.json"), launchBroker,
      provider: async () => ({ id: "test", probe: async () => {
        started.resolve(); await finish.promise;
        return { available: true, isolated: true, clipboardBoundary: "isolated", independentWatchdog: true,
          recovery: "window-moved", canAdoptWindows: false, unicodeText: true };
      } }) as unknown as WorkspaceProvider });
    try {
      const pending = manager.session({ operation: "open", request_id: "revoked-before-record", mode: "isolated" }, f.context);
      const rejected = expect(pending).rejects.toMatchObject({ code: "workspace_authorization_revoked" });
      await started.promise;
      await manager.revokeOwner(f.context.caller!.ownerKey);
      finish.resolve(); await rejected;
      expect(launchBroker).not.toHaveBeenCalled();
      expect(manager.updateBlockedReason()).toBeUndefined();
    } finally { finish.resolve(); await manager.dispose(); }
  });

  it("does not leave an update-blocking lease when the standalone launcher is missing", async () => {
    const f = fixture();
    const manager = new WorkspaceManager({ configPath: join(mkdtempSync(join(tmpdir(), "workspace-missing-")), "device.json"),
      entryPoint: join(tmpdir(), "missing-" + randomUUID(), "cli.cjs"),
      provider: async () => ({ id: "test", probe: async () => ({ available: true, isolated: true,
        clipboardBoundary: "isolated", independentWatchdog: true, recovery: "window-moved", canAdoptWindows: false, unicodeText: true }) }) as unknown as WorkspaceProvider });
    try {
      await expect(manager.session({ operation: "open", request_id: "missing-launcher", mode: "isolated" }, f.context))
        .rejects.toMatchObject({ code: "workspace_bundle_required" });
      expect(manager.updateBlockedReason()).toBeUndefined();
    } finally { await manager.dispose(); }
  });

  it("fails closed on an older server without authenticated caller metadata", async () => {
    const provider = vi.fn(async () => { throw new Error("provider must not be created"); });
    const manager = new WorkspaceManager({ configPath: join(mkdtempSync(join(tmpdir(), "workspace-auth-")), "device.json"), provider });
    const f = fixture();
    try {
      await expect(manager.session({ operation: "status" }, { ...f.context, caller: undefined }))
        .rejects.toMatchObject({ code: "workspace_authenticated_context_required" });
      await expect(manager.session({ operation: "status" }, { ...f.context,
        caller: { ...f.context.caller!, authorizationExpiresAt: Date.now() - 1 } }))
        .rejects.toMatchObject({ code: "workspace_authenticated_context_required" });
      expect(provider).not.toHaveBeenCalled();
    } finally { await manager.dispose(); }
  });
});
