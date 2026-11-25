import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceController, type WorkspaceJournal } from "../src/computer/workspace-state.js";
import type { WorkspaceProvider, WorkspaceRecoveryResult, WorkspaceResource } from "../src/computer/workspace-types.js";

function fixture() {
  let wall = 1000000, mono = 0;
  const leaseId = randomUUID();
  const display = { id: "private:1", instanceId: leaseId, x: 0, y: 0, width: 800, height: 600 };
  const resource: WorkspaceResource = { providerId: "fake-private", leaseId, instanceId: leaseId, display, data: {} };
  const recovered: WorkspaceRecoveryResult = { complete: true, outcome: "window-moved", inputRevoked: true, ownedDisplayRemoved: true };
  const history: WorkspaceJournal[] = [];
  let fenced = false;
  const journal: WorkspaceJournal = {
    schema: 1, leaseId, providerId: "fake-private", phase: "preparing", createdAt: wall, updatedAt: wall,
    owner: { ownerKey: "caller-owner-1", connectionEpoch: "epoch-1", authorizationExpiresAt: wall + 600000 },
    options: { leaseId, width: 800, height: 600, expiresAt: wall + 120000, hardExpiresAt: wall + 600000 }
  };
  const provider: WorkspaceProvider = {
    id: "fake-private",
    probe: vi.fn(async () => ({ available: true, isolated: true, clipboardBoundary: "isolated", independentWatchdog: true,
      canAdoptWindows: true, recovery: "window-moved", unicodeText: true })),
    open: vi.fn(async (_options, context) => { await context.checkpoint(resource); return resource; }),
    renew: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ platform: "linux", backend: "fake-private", available: true, displayKind: "virtual",
      inputKind: "mouse_keyboard", displays: [display], actions: ["text", "click"], unicodeText: true, permissions: {} })),
    capture: vi.fn(async () => ({ data: Buffer.from("fake"), mimeType: "image/png", display, capturedAt: wall })),
    act: vi.fn(async () => ({ applied: true })),
    recover: vi.fn(async () => recovered)
  };
  const controller = new WorkspaceController({ directory: "/unused", journal, provider, wallNow: () => wall, monotonicNow: () => mono,
    persist: async value => { history.push(structuredClone(value)); }, revoke: async () => { fenced = true; } });
  return { controller, provider, history, resource, recovered, journal, isFenced: () => fenced,
    advance(ms: number) { wall += ms; mono += ms; },
    wall(value: number) { wall = value; },
    heartbeat() { controller.heartbeat(journal.owner, wall); }
  };
}

describe("independent workspace lease controller", () => {
  it("persists creation intent before resource mutation and never selects a physical fallback", async () => {
    const f = fixture();
    vi.mocked(f.provider.open).mockImplementation(async (_options, context) => {
      expect(f.history[0]?.phase).toBe("preparing");
      await context.checkpoint(f.resource);
      expect(f.history.at(-1)?.resource?.instanceId).toBe(f.resource.instanceId);
      return f.resource;
    });
    await f.controller.open();
    expect(f.controller.status()).toMatchObject({ state: "active", input_allowed: true });
    vi.mocked(f.provider.capture).mockResolvedValueOnce({ data: Buffer.from("fake"), mimeType: "image/png",
      display: { ...f.resource.display, id: "physical:0" }, capturedAt: 1000000 });
    await expect(f.controller.capture(1000)).rejects.toMatchObject({ code: "workspace_target_changed" });
  });

  it("refuses an unsupported isolation provider before open", async () => {
    const f = fixture();
    vi.mocked(f.provider.probe).mockResolvedValueOnce({ available: true, isolated: false, clipboardBoundary: "shared-app-state",
      independentWatchdog: true, canAdoptWindows: false, recovery: "window-moved", unicodeText: false });
    await expect(f.controller.open()).rejects.toMatchObject({ code: "isolated_workspace_unavailable" });
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(f.controller.status().state).toBe("closed");
  });

  it("heartbeats keep the native guardian alive without extending the agent TTL", async () => {
    const f = fixture();
    await f.controller.open();
    f.advance(2000); f.heartbeat(); await f.controller.tick();
    expect(f.provider.renew).toHaveBeenCalledWith(f.resource, f.journal.options.expiresAt, expect.anything());
    expect(f.controller.journal.options.expiresAt).toBe(f.journal.options.expiresAt);
    f.advance(118001); f.heartbeat(); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ state: "closed", close_reason: "expired", input_allowed: false });
  });

  it("expires on a monotonic deadline even when wall time moves backwards", async () => {
    const f = fixture(); await f.controller.open();
    f.advance(120001); f.wall(900000); f.heartbeat(); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ state: "closed", close_reason: "expired" });
  });

  it("recovers when the worker heartbeat disappears independently of normal lease TTL", async () => {
    const f = fixture(); await f.controller.open();
    f.advance(15001); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ state: "closed", close_reason: "owner_lost" });
  });

  it("does not let a live worker disguise a stale authenticated server connection", async () => {
    const f = fixture(); await f.controller.open();
    f.advance(65001); f.controller.heartbeat(f.journal.owner, 1000000); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ state: "closed", close_reason: "disconnected" });
  });

  it("binds owner and connection epoch and limits renewals to authorization", async () => {
    const f = fixture(); await f.controller.open();
    expect(() => f.controller.authorize({ ...f.journal.owner, ownerKey: "another-owner" })).toThrow(/another authenticated/);
    expect(() => f.controller.authorize({ ...f.journal.owner, connectionEpoch: "reconnected" })).toThrow(/another authenticated/);
    await f.controller.renew({ ...f.journal.owner, authorizationExpiresAt: 1005000 }, 300000);
    expect(f.controller.journal.options.expiresAt).toBe(1005000);
  });

  it("never replays an action with a known or unknown previous outcome", async () => {
    const f = fixture(); await f.controller.open();
    const action = { type: "text" as const, text: "one" };
    await f.controller.act("once", action, 1000);
    await expect(f.controller.act("once", action, 1000)).resolves.toMatchObject({ cached: true });
    expect(f.provider.act).toHaveBeenCalledTimes(1);
    await expect(f.controller.act("once", { ...action, text: "two" }, 1000)).rejects.toMatchObject({ code: "request_id_conflict" });
    vi.mocked(f.provider.act).mockRejectedValueOnce(new Error("unknown after input"));
    await expect(f.controller.act("unknown", action, 1000)).rejects.toThrow();
    await expect(f.controller.act("unknown", action, 1000)).rejects.toMatchObject({ code: "workspace_action_unknown" });
    expect(f.provider.act).toHaveBeenCalledTimes(2);
  });

  it("retains an incomplete recovery and retries idempotently with input disabled", async () => {
    const f = fixture(); await f.controller.open();
    vi.mocked(f.provider.recover).mockResolvedValueOnce({ complete: false, outcome: "cleanup-pending", inputRevoked: true, ownedDisplayRemoved: false });
    await f.controller.close("explicit");
    expect(f.controller.status()).toMatchObject({ state: "cleanup_pending", input_allowed: false });
    await expect(f.controller.act("late", { type: "text", text: "no" }, 1000)).rejects.toMatchObject({ code: "workspace_closed" });
    await f.controller.tick();
    expect(f.controller.status().state).toBe("closed");
    await f.controller.close("explicit");
    expect(f.provider.recover).toHaveBeenCalledTimes(2);
  });

  it("treats a returned viewer as complete only after agent input was revoked", async () => {
    const f = fixture(); await f.controller.open();
    vi.mocked(f.provider.recover).mockResolvedValueOnce({ complete: true, outcome: "handoff-viewer", inputRevoked: false, ownedDisplayRemoved: false });
    await f.controller.close("explicit");
    expect(f.controller.status().state).toBe("cleanup_pending");
  });

  it("checks expiry before new input even between watchdog ticks", async () => {
    const f = fixture(); await f.controller.open();
    f.advance(120001);
    await expect(f.controller.act("past-deadline", { type: "key", keys: ["A"] }, 1000)).rejects.toMatchObject({ code: "workspace_closed" });
    expect(f.provider.act).not.toHaveBeenCalled();
    expect(f.controller.status().input_allowed).toBe(false);
  });

  it("keeps the frame application identity through the independent broker", async () => {
    const f = fixture(); await f.controller.open();
    await f.controller.inspect(1000, "captured-app");
    await f.controller.act("bound-app", { type: "text", text: "one" }, 1000, "captured-app");
    expect(f.provider.inspect).toHaveBeenCalledWith(f.resource, expect.objectContaining({ expectedAppId: "captured-app" }));
    expect(f.provider.act).toHaveBeenCalledWith(f.resource, expect.anything(), expect.objectContaining({ expectedAppId: "captured-app" }));
    await expect(f.controller.act("bound-app", { type: "text", text: "one" }, 1000, "different-app"))
      .rejects.toMatchObject({ code: "request_id_conflict" });
  });

  it("does not report cleanup complete while creation can still produce resources", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    vi.mocked(f.provider.open).mockImplementation(async (_options, context) => {
      await context.checkpoint(f.resource); started.resolve();
      await finish.promise; return f.resource;
    });
    const opening = f.controller.open();
    const rejected = expect(opening).rejects.toMatchObject({ code: "workspace_closed" });
    await started.promise;
    await expect(f.controller.open()).rejects.toMatchObject({ code: "workspace_state" });
    await f.controller.close("disconnected");
    expect(f.controller.status()).toMatchObject({ state: "cleanup_pending", input_allowed: false });
    finish.resolve();
    await rejected;
    await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ state: "closed", input_allowed: false });
    expect(f.provider.recover).toHaveBeenCalledTimes(2);
  });

  it("starts independent recovery even if an input provider ignores cancellation", async () => {
    const f = fixture(); await f.controller.open();
    const finish = Promise.withResolvers<Record<string, unknown>>();
    vi.mocked(f.provider.act).mockReturnValueOnce(finish.promise);
    const result = f.controller.act("uncooperative", { type: "key", keys: ["A"] }, 10);
    await expect(result).rejects.toMatchObject({ code: "workspace_cancelled" });
    expect(f.provider.recover).toHaveBeenCalled();
    expect(f.controller.status().input_allowed).toBe(false);
    finish.resolve({ applied: true });
    await expect(f.controller.act("uncooperative", { type: "key", keys: ["A"] }, 1000))
      .rejects.toMatchObject({ code: "workspace_action_unknown" });
  });

  it("persists the permanent revocation fence before native recovery and rejects late creation checkpoints", async () => {
    const f = fixture(); let checkpoint: ((resource: WorkspaceResource) => Promise<void>) | undefined;
    vi.mocked(f.provider.open).mockImplementation(async (_options, context) => {
      checkpoint = context.checkpoint; await checkpoint(f.resource); return f.resource;
    });
    vi.mocked(f.provider.recover).mockImplementation(async (_resource, _options, _reason, context) => {
      expect(f.isFenced()).toBe(true); expect(context.revocationPath).toBe(join("/unused", "revoked.json"));
      return f.recovered;
    });
    await f.controller.open(); await f.controller.close("disconnected");
    await expect(checkpoint!(f.resource)).rejects.toMatchObject({ code: "workspace_closed" });
    expect(f.controller.status().state).toBe("cleanup_pending");
    await f.controller.tick();
    expect(f.controller.status().state).toBe("closed");
  });

  it("recovery gets an independent signal when an action times out", async () => {
    const f = fixture(); await f.controller.open();
    vi.mocked(f.provider.act).mockImplementation(async (_resource, _action, context) => new Promise((_resolve, reject) => {
      context.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    vi.mocked(f.provider.recover).mockImplementation(async (_resource, _options, _reason, context) => {
      expect(context.signal?.aborted).toBe(false);
      return f.recovered;
    });
    await expect(f.controller.act("timeout", { type: "text", text: "one" }, 10)).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.controller.status()).toMatchObject({ state: "closed", input_allowed: false });
  });
});
