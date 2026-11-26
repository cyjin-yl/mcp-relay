import { describe, expect, it, vi } from "vitest";
import { createWindowsWorkspaceProvider, mapAnodeAction, validateAnodeStatus } from "../src/computer/workspace-windows.js";
import { ANODE_EXECUTABLE_BYTES, ANODE_EXECUTABLE_SHA256, ANODE_RUNTIME_VERSION, serializeAnodeRequest, WINDOWS_WORKSPACE_OWNER, WINDOWS_WORKSPACE_GUARDIAN, WINDOWS_HIDDEN_LAUNCHER } from "../src/computer/workspace-windows-runtime.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext, WorkspaceResource } from "../src/computer/workspace-types.js";

const NOW = 100000;
const options: WorkspaceOpenOptions = { leaseId: "lease-test", width: 1280, height: 720, expiresAt: NOW + 30000, hardExpiresAt: NOW + 60000 };
function resource(): WorkspaceResource {
  return { providerId: "windows-anode-child-session", leaseId: options.leaseId, instanceId: "test-instance",
    display: { id: "test-display", instanceId: "test-instance", x: 0, y: 0, width: 1280, height: 720, scaleX: 1, scaleY: 1 },
    data: { channel: "mcp-relay-0123456789abcdef", agentId: "relay-test", leaseToken: "native-token", stateFile: "C:\\private\\guardian.json",
      runtimeExe: "C:\\private\\anode.exe", instanceId: "test-instance", parentSession: 1, childSession: 3, seatPid: 123,
      revocationPath: "C:\\private\\revoked.json", width: 1280, height: 720,
      brokerPid: 42, brokerStarted: "134086752000000001", expiresAt: NOW + 30000, hardExpiresAt: NOW + 60000, sequence: 1, phase: "active" } };
}
function status(r = resource()) {
  return { state: "ready", channel: r.data.channel, parentSession: 1, session: 3, agentReady: true, viewerConnection: 1,
    viewOnly: true, backgroundRenderingConfigured: true, pointerGuard: { installed: true, patchedImports: 1, suppressed: 4, forwarded: 0 },
    seat: { session: 3, pid: 123, screen: { width: 1280, height: 720 } }, lease: { ownerAgentId: r.data.agentId } };
}
function harness(changes: { now?: number; recovery?: Record<string, unknown>; reply?: Record<string, unknown>;
  statusPatch?: Record<string, unknown>; revoked?: boolean; missingStateDirectory?: boolean; recoveryResult?: Record<string, unknown>;
  nativeRecoverError?: boolean; guardianError?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  let persisted: Record<string, unknown> = {}, revoked = changes.revoked ?? false, revocationWrites = 0;
  const native = vi.fn(async (q: Record<string, unknown>) => {
    if (q.op === "inspect") return { scriptHostAvailable: true, enabled: true, elevated: false, interactive: true, childSession: null, parentSession: 1,
      brokerSession: 1, brokerStarted: "134086752000000001" };
    if (q.op === "guardian-check") { if (changes.guardianError) throw new Error("guardian died"); return { ready: true }; }
    if (q.op === "lease-acquire") return { ownerAgentId: persisted.agentId, leaseToken: "native-token", expiresInMs: 10000 };
    if (q.op === "recover") {
      if (changes.nativeRecoverError) throw new Error("The owned child session changed.");
      return changes.recoveryResult ?? { complete: true, outcome: "handoff-viewer", inputRevoked: true, ownedDisplayRemoved: false, viewerVisible: true };
    }
    return { started: true };
  });
  const request = vi.fn(async (channel: string, q: Record<string, unknown>) => {
    calls.push(q);
    if (q.op === "status") return changes.reply ?? { ...status(), channel, lease: { ownerAgentId: null }, ...changes.statusPatch };
    if (q.op === "lease") return { ownerAgentId: q.agentId, leaseToken: "native-token", expiresInMs: 10000 };
    return { performed: true };
  });
  const writeJson = vi.fn(async (_path: string, value: unknown) => { persisted = structuredClone(value as Record<string, unknown>); });
  const ctx: WorkspaceProviderContext = { journalDirectory: "C:\\private", revocationPath: "C:\\private\\revoked.json", timeoutMs: 3000, checkpoint: vi.fn(async () => {}) };
  const provider = createWindowsWorkspaceProvider({
    runtimePath: () => "C:\\private\\anode.exe", verifyRuntime: vi.fn(async () => {}), installRuntime: vi.fn(async () => ({ installed: true })),
    native, request, writeJson, writeHelpers: vi.fn(async () => {}),
    readArtifact: vi.fn(async path => path.endsWith(".guardian-ready.json") ? { instanceId: persisted.instanceId } : undefined),
    revoked: vi.fn(async () => revoked), revoke: vi.fn(async () => {
      if (changes.missingStateDirectory && revocationWrites++ === 0) throw Object.assign(new Error("missing state directory"), { code: "ENOENT" });
      revoked = true;
    }),
    readRecovery: vi.fn(async () => changes.recovery), now: () => changes.now ?? NOW,
  });
  return { provider, calls, request, native, ctx, writeJson };
}
describe("Windows isolated workspace", () => {
  it("pins the audited source runtime and an immutable executable digest", () => {
    expect(ANODE_RUNTIME_VERSION).toBe("10.0.14");
    expect(ANODE_EXECUTABLE_BYTES).toBeGreaterThan(1_000_000);
    expect(ANODE_EXECUTABLE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("serializes FILETIME exactly instead of losing low bits in JavaScript Number", () => {
    const encoded = serializeAnodeRequest({ op: "lease", clientStarted: "134086752000000001", text: "\"clientStarted\":\"123\"" });
    expect(encoded).toContain('"clientStarted":134086752000000001');
    expect(encoded).toContain('"text":"\\"clientStarted\\":\\"123\\""');
    expect(() => serializeAnodeRequest({ clientStarted: 134086752000000001 })).toThrow();
    expect(() => serializeAnodeRequest({ clientStarted: "9999999999999999999" })).toThrow();
  });
  it("refuses wrong parent, reused child, missing pointer guard and human control", () => {
    const r = resource();
    for (const mutation of [
      { parentSession: 0 }, { session: 4 }, { channel: "main" }, { viewOnly: false },
      { pointerGuard: { installed: false, patchedImports: 0 } }, { seat: { session: 3, pid: 124 } },
    ]) expect(() => validateAnodeStatus({ ...status(r), ...mutation }, r)).toThrow();
  });
  it("makes capabilities read-only and never starts or installs a runtime", async () => {
    const h = harness();
    expect(await h.provider.probe(h.ctx)).toMatchObject({ available: true, isolated: true, clipboardBoundary: "isolated", recovery: "handoff-viewer" });
    expect(h.calls).toEqual([]);
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(h.native.mock.calls[0]![0].op).toBe("inspect");
    expect(h.writeJson).not.toHaveBeenCalled();
  });
  it("refuses adoption before any native mutation", async () => {
    const h = harness();
    await expect(h.provider.open({ ...options, windowIds: ["physical-window"] }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_WINDOW_ADOPTION_UNSUPPORTED" });
    expect(h.native).not.toHaveBeenCalled();
  });
  it("starts owner and guardian only as separate interactive scheduled tasks", async () => {
    const h = harness();
    const r = await h.provider.open(options, h.ctx);
    expect(r.data.childSession).toBe(3);
    const launches = h.native.mock.calls.map(c => c[0]).filter(q => q.op === "launch");
    expect(launches).toHaveLength(2);
    expect(launches.every(q => q.parentSession === 1)).toBe(true);
    const owner = launches.find(q => String(q.taskName).includes("Owner"))!;
    for (const launch of launches) {
      expect(String(launch.executable).toLowerCase()).toMatch(/\\system32\\wscript\.exe$/);
      expect(launch.arguments).toEqual(expect.arrayContaining(["//B", "//Nologo", "-WindowStyle", "Hidden", "-EncodedCommand"]));
    }
    expect(owner.arguments).not.toContain("-File");
    expect(h.native.mock.calls.map(c => c[0].op)).toEqual(["inspect", "protect", "launch", "guardian-check", "launch", "lease-acquire"]);
    expect(WINDOWS_WORKSPACE_OWNER).toContain("'up','--keep','--width'");
    expect(WINDOWS_WORKSPACE_OWNER).not.toContain("--no-background-rendering");
    expect(WINDOWS_WORKSPACE_OWNER).toContain("'--state-dir',[IO.Path]::GetDirectoryName($StatePath)");
    expect(WINDOWS_WORKSPACE_OWNER).toContain("if($c.interactiveSignIn -eq $true){$arguments+= '--sign-in'}else{$arguments+= '--hidden'}");
    for (const flag of ["--clipboard", "--audio", "--control"]) expect(WINDOWS_WORKSPACE_OWNER).not.toContain(flag);
    expect(h.calls.some(q => q.op === "lease")).toBe(false);
    expect(h.ctx.checkpoint).toHaveBeenCalled();
  });
  it("cannot send input after the native watchdog has begun recovery", async () => {
    const h = harness({ recovery: { complete: false, outcome: "cleanup-pending" } });
    await expect(h.provider.act(resource(), { type: "click", x: 4, y: 5 }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
    expect(h.calls).toEqual([]);
  });
  it("cannot send or renew an expired native workspace", async () => {
    const h = harness({ now: NOW + 30001 });
    await expect(h.provider.act(resource(), { type: "key", keys: ["enter"] }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_LEASE_EXPIRED" });
    await expect(h.provider.renew(resource(), NOW + 45000, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_LEASE_EXPIRED" });
    expect(h.calls).toEqual([]);
  });
  it("bounds renew to the original hard authorization even when a caller requests more", async () => {
    const h = harness(); const r = resource();
    await h.provider.renew(r, NOW + 90000, h.ctx);
    expect(r.data.expiresAt).toBe(NOW + 60000);
    expect(h.calls.find(q => q.op === "lease")).toMatchObject({ action: "renew", ttlSeconds: 10, leaseToken: "native-token" });
  });
  it("routes text and keys into the native lease without touching a physical backend", async () => {
    const h = harness(); const r = resource();
    await h.provider.act(r, { type: "text", text: "你好🙂" }, h.ctx);
    expect(h.calls.at(-1)).toMatchObject({ op: "input.text", text: "你好🙂", agentId: r.data.agentId, leaseToken: "native-token" });
    expect(mapAnodeAction(r, { type: "key", keys: ["ctrl", "a"] })).toEqual([{ op: "input.key", keys: "vk11+vk41" }]);
    expect(h.native).not.toHaveBeenCalled();
  });
  it("maps source-pixel coordinates and refuses out-of-frame values", () => {
    const r = resource();
    expect(mapAnodeAction(r, { type: "click", x: 1279, y: 719, button: "right", clicks: 2 })).toEqual([
      { op: "input.click", x: 1279, y: 719, button: "right", count: 2 },
    ]);
    for (const [x, y] of [[1280, 1], [1, 720], [-1, 1], [NaN, 1]]) expect(() => mapAnodeAction(r, { type: "move", x: x!, y: y! })).toThrow();
  });
  it("hands back a retained viewer only after native lease revocation is observed", async () => {
    const h = harness();
    expect(await h.provider.recover(resource(), options, "disconnected", h.ctx)).toMatchObject({
      complete: true, outcome: "handoff-viewer", inputRevoked: true, ownedDisplayRemoved: false,
    });
    expect(h.calls).toEqual([]);
    expect(h.native).toHaveBeenCalledWith(expect.objectContaining({ op: "recover", reason: "disconnected" }), h.ctx);
    await expect(h.provider.act(resource(), { type: "text", text: "late input" }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
  });
  it("does not treat an absent lease response as successful revocation", async () => {
    const h = harness({ recoveryResult: { complete: true, outcome: "handoff-viewer", inputRevoked: false } });
    expect(await h.provider.recover(resource(), options, "expired", h.ctx)).toMatchObject({
      complete: false, outcome: "cleanup-pending", inputRevoked: false,
    });
  });
  it("does not show or release a foreign child-session channel", async () => {
    const h = harness({ nativeRecoverError: true });
    expect(await h.provider.recover(resource(), options, "recovery", h.ctx)).toMatchObject({ complete: false });
    expect(h.calls).toEqual([]);
    expect(h.native.mock.calls.map(c => c[0].op)).toEqual(["recover"]);
  });
  it("checks the pointer guard on every input admission", async () => {
    const h = harness({ reply: { ...status(), pointerGuard: { installed: false, patchedImports: 0 } } });
    await expect(h.provider.act(resource(), { type: "click", x: 10, y: 10 }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_POINTER_GUARD_UNAVAILABLE" });
    expect(h.calls.map(q => q.op)).toEqual(["status"]);
  });
  it("refuses permanent revocation before creation and before each action or renew", async () => {
    const h = harness({ revoked: true });
    await expect(h.provider.open(options, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
    await expect(h.provider.act(resource(), { type: "text", text: "blocked" }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
    await expect(h.provider.renew(resource(), NOW + 40000, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
    expect(h.calls).toEqual([]);
    expect(h.native.mock.calls.every(c => c[0].op === "inspect")).toBe(true);
  });
  it("does not launch an owner unless the independent guardian's live identity is confirmed", async () => {
    const h = harness({ guardianError: true });
    await expect(h.provider.open(options, h.ctx)).rejects.toThrow("guardian died");
    expect(h.native.mock.calls.filter(c => c[0].op === "launch")).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });
  it("clamps rounded coordinates within source bounds and rejects unsupported native options", () => {
    expect(mapAnodeAction(resource(), { type: "move", x: 1279.9, y: 719.9 })).toEqual([{ op: "input.move", x: 1279, y: 719 }]);
    expect(() => mapAnodeAction(resource(), { type: "click", x: 1, y: 1, clicks: 3 })).toThrow(/single or double/);
    expect(() => mapAnodeAction(resource(), { type: "drag", fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 400 })).toThrow(/native drag timing/);
  });
  it("uses creation-time hidden windows and a permanent shared native creation gate", () => {
    expect(WINDOWS_HIDDEN_LAUNCHER).toContain("shell.Run(command, 0, True)");
    expect(WINDOWS_WORKSPACE_OWNER).toContain("$start.CreateNoWindow=$true");
    expect(WINDOWS_WORKSPACE_OWNER).toContain("Assert-Creating (Read-WorkspaceState $StatePath)");
    expect(WINDOWS_WORKSPACE_OWNER).toContain("Enter-WorkspaceGate $c");
    expect(WINDOWS_WORKSPACE_GUARDIAN).toContain("Set-WorkspaceRevoked $c $reason");
    expect(WINDOWS_WORKSPACE_GUARDIAN).toContain("$expiryDeadline");
  });
  it("accepts verified empty-startup cleanup and preserves an ambiguous outcome", async () => {
    const empty = harness({ recoveryResult: { complete: true, inputRevoked: true, outcome: "no-resources", ownedDisplayRemoved: true } });
    expect(await empty.provider.recover(resource(), options, "open_failed", empty.ctx)).toMatchObject({ complete: true, outcome: "no-resources", ownedDisplayRemoved: true });
    const unknown = harness({ recoveryResult: { complete: true, inputRevoked: true, outcome: "unknown" } });
    expect(await unknown.provider.recover(resource(), options, "open_failed", unknown.ctx)).toMatchObject({ complete: false, outcome: "cleanup-pending" });
  });

  it("allows only explicitly requested native sign-in and hides the viewer before activation", async () => {
    const h = harness();
    const opened = await h.provider.open({ ...options, interactiveSignIn: true }, h.ctx);
    expect(opened.data.interactiveSignIn).toBe(true);
    expect(h.calls).toEqual(expect.arrayContaining([{ op: "seat.hide" }]));
    const hideIndex = h.request.mock.calls.findIndex(([, q]) => q.op === "seat.hide");
    const acquireIndex = h.native.mock.calls.findIndex(([q]) => q.op === "lease-acquire");
    expect(h.request.mock.invocationCallOrder[hideIndex]).toBeLessThan(h.native.mock.invocationCallOrder[acquireIndex]!);
    expect(h.writeJson.mock.calls.some(c => (c[1] as Record<string, unknown>).phase === "preparing")).toBe(true);
    const ordinary = harness();
    const invisible = await ordinary.provider.open(options, ordinary.ctx);
    expect(invisible.data.interactiveSignIn).toBe(false);
    expect(ordinary.calls.some(c => c.op === "seat.hide")).toBe(false);
  });

  it.each([
    { label: "interactive sign-in", interactiveSignIn: true, configured: false },
    { label: "unattended sign-in", interactiveSignIn: false, configured: false },
    { label: "missing status field", interactiveSignIn: true, configured: undefined },
    { label: "non-boolean status field", interactiveSignIn: true, configured: "true" },
  ])("refuses activation without the rendering prerequisite: $label", async ({ interactiveSignIn, configured }) => {
    const h = harness({ statusPatch: { backgroundRenderingConfigured: configured } });
    await expect(h.provider.open({ ...options, interactiveSignIn,
      launch: { executable: "C:\\private\\fixture.exe", args: [] } }, h.ctx)).rejects.toMatchObject({
      code: "WORKSPACE_BACKGROUND_RENDERING_UNAVAILABLE",
    });
    expect(h.calls.map(q => q.op)).toEqual(["status"]);
    expect(h.native.mock.calls.some(([q]) => q.op === "lease-acquire")).toBe(false);
    expect(h.writeJson.mock.calls.every(([, value]) => (value as Record<string, unknown>).phase === "preparing")).toBe(true);
  });

  it("hands back a rendering-setup failure without granting or reactivating agent input", async () => {
    const h = harness({ statusPatch: { backgroundRenderingConfigured: false } });
    await expect(h.provider.open({ ...options, interactiveSignIn: true }, h.ctx)).rejects.toMatchObject({
      code: "WORKSPACE_BACKGROUND_RENDERING_UNAVAILABLE",
    });
    const prepared = vi.mocked(h.ctx.checkpoint).mock.calls.at(-1)![0];
    expect(prepared.data).toMatchObject({ childSession: 3, seatPid: 123, phase: "preparing",
      expiresAt: options.expiresAt, hardExpiresAt: options.hardExpiresAt });
    expect(await h.provider.recover(prepared, options, "open_failed", h.ctx)).toMatchObject({
      complete: true, outcome: "handoff-viewer", inputRevoked: true, ownedDisplayRemoved: false,
    });
    await expect(h.provider.act(prepared, { type: "text", text: "late input" }, h.ctx)).rejects.toMatchObject({ code: "WORKSPACE_HANDED_OFF" });
    expect(h.calls.map(q => q.op)).toEqual(["status"]);
    expect(h.native.mock.calls.map(([q]) => q.op)).toEqual(["inspect", "protect", "launch", "guardian-check", "launch", "recover"]);
  });

  it("recovers an intent checkpointed before its private state directory existed", async () => {
    const h = harness({ missingStateDirectory: true, recoveryResult: { complete: true, inputRevoked: true, outcome: "no-resources", ownedDisplayRemoved: true } });
    expect(await h.provider.recover(resource(), options, "open_failed", h.ctx)).toMatchObject({ complete: true, outcome: "no-resources" });
    expect(h.native.mock.calls.map(c => c[0].op)).toEqual(["protect", "recover"]);
  });

});
