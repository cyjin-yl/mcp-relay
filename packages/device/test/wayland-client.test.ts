import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ children: [] as ChildProcess[] }));
vi.mock("node:child_process", async original => {
  const module = await original<typeof import("node:child_process")>();
  return { ...module, spawn: (...args: Parameters<typeof module.spawn>) => {
    const child = module.spawn(...args); observed.children.push(child); return child;
  } };
});
import { WaylandPortalClient, createWaylandBackend } from "../src/computer/wayland.js";
import { createLinuxBackend } from "../src/computer/linux.js";

// This fixture exercises real process ownership/IPC, not portal compatibility.
// Real compositor and portal acceptance lives in manual/wayland-portal-smoke.*.
const source = String.raw`
import json, os, signal, sys, time, uuid
session = str(uuid.uuid4())
ready = False
def stop(*args):
    time.sleep(0.06)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
for line in sys.stdin:
    req = json.loads(line)
    if req.get('hang'):
        time.sleep(30)
    if req.get('mismatch'):
        print(json.dumps({'id':'wrong','ok':True,'result':{}}), flush=True)
        continue
    if req.get('oversized'):
        print('x' * (18 * 1024 * 1024), flush=True)
        continue
    if req.get('exit'):
        sys.exit(0)
    if req.get('fail'):
        print(json.dumps({'id':req['id'],'ok':False,'error':{'code':'permission_denied','message':'Consent was cancelled.'}}), flush=True)
        continue
    if req['operation'] == 'setup':
        ready = True
    result = {'pid':os.getpid(),'session':session,'ready':ready,'operation':req['operation']}
    print(json.dumps({'id':req['id'],'ok':True,'result':result}), flush=True)
`;
const ctx = { timeoutMs: 5000 };

describe.skipIf(process.platform !== "linux")("Wayland private helper lifetime", () => {
  it("retains one process across calls and requires fresh setup after close", async () => {
    const client = new WaylandPortalClient(process.env, { source });
    try {
      const first = await client.call("setup", {}, ctx) as Record<string, unknown>;
      const observed = await client.call("inspect", {}, ctx) as Record<string, unknown>;
      expect(observed).toMatchObject({ pid: first.pid, session: first.session, ready: true });
      await client.close();
      expect(() => process.kill(first.pid as number, 0)).toThrow();
      const fresh = await client.call("inspect", {}, ctx) as Record<string, unknown>;
      expect(fresh.session).not.toBe(first.session);
      expect(fresh.ready).toBe(false);
    } finally { await client.close(); }
  });

  it("never spawns for an already-cancelled call", async () => {
    const before = observed.children.length;
    const client = new WaylandPortalClient(process.env, { source });
    await expect(client.call("setup", {}, { ...ctx, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(observed.children).toHaveLength(before);
    await client.close();
  });

  it("rejects overlapping commands and waits for SIGTERM cleanup before reporting cancellation", async () => {
    const client = new WaylandPortalClient(process.env, { source });
    const controller = new AbortController();
    await client.call("setup", {}, ctx);
    const child = observed.children.at(-1)!;
    const request = client.call("act", { hang: true }, { ...ctx, signal: controller.signal });
    const checked = expect(request).rejects.toMatchObject({ code: "cancelled", details: { mayHaveApplied: true } });
    await expect(client.call("inspect", {}, ctx)).rejects.toMatchObject({ code: "computer_busy" });
    const started = Date.now();
    controller.abort();
    await checked;
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    await client.close();
  });

  it("reaps a helper that ignores SIGTERM before releasing a timed out request", async () => {
    const client = new WaylandPortalClient(process.env, { source: source.replace(
      "signal.signal(signal.SIGTERM, stop)", "signal.signal(signal.SIGTERM, signal.SIG_IGN)") });
    await client.call("setup", {}, ctx);
    const child = observed.children.at(-1)!;
    const started = Date.now();
    await expect(client.call("act", { hang: true }, { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(child.signalCode).toBe("SIGKILL");
    await client.close();
  });

  it("a live child error is not mistaken for a real exit", async () => {
    const client = new WaylandPortalClient(process.env, { source });
    await client.call("setup", {}, ctx);
    const child = observed.children.at(-1)!;
    let realExit = false;
    child.once("exit", () => { realExit = true; });
    const request = client.call("act", { hang: true }, ctx);
    const checked = expect(request).rejects.toMatchObject({ code: "native_process_failed" });
    child.emit("error", Object.assign(new Error("fixture signal failure"), { code: "EPERM" }));
    child.emit("error", Object.assign(new Error("fixture repeated signal failure"), { code: "EPERM" }));
    await checked;
    expect(realExit).toBe(true);
    await client.close();
  });

  it.each(["mismatch", "oversized"])("closes a helper after a %s response", async failure => {
    const client = new WaylandPortalClient(process.env, { source });
    await expect(client.call("inspect", { [failure]: true }, ctx)).rejects.toMatchObject({ code: "portal_invalid_response" });
    const child = observed.children.at(-1)!;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await client.close();
  });

  it("reports input outcome as unknown when the helper dies before its receipt", async () => {
    const client = new WaylandPortalClient(process.env, { source });
    await expect(client.call("act", { exit: true }, ctx)).rejects.toMatchObject({
      code: "portal_session_closed", details: { mayHaveApplied: true }
    });
    await client.close();
  });

  it("reports missing Python without a fictitious live helper", async () => {
    const client = new WaylandPortalClient(process.env, { python: "/missing-relay-wayland-python" });
    await expect(client.call("inspect", {}, ctx)).rejects.toMatchObject({ code: "native_spawn_failed", details: { mayHaveApplied: false } });
    await client.close();
  });

  it("expires an idle permission process without blocking the caller", async () => {
    const client = new WaylandPortalClient(process.env, { source, idleTimeoutMs: 50 });
    await client.call("setup", {}, ctx);
    const child = observed.children.at(-1)!;
    await once(child, "exit");
    const result = await client.call("inspect", {}, ctx) as Record<string, unknown>;
    expect(result.ready).toBe(false);
    await client.close();
  });

  it("runs cancellation cleanup before any next process can begin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-wayland-client-"));
    const marker = join(directory, "released");
    const markerSource = source.replace("time.sleep(0.06)", `time.sleep(0.1)\n    open(${JSON.stringify(marker)}, 'w').write('released')`);
    const client = new WaylandPortalClient(process.env, { source: markerSource });
    await client.call("setup", {}, ctx);
    const controller = new AbortController();
    const request = client.call("act", { hang: true }, { ...ctx, signal: controller.signal });
    const checked = expect(request).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    const next = client.call("inspect", {}, ctx);
    await checked;
    await next;
    expect(readFileSync(marker, "utf8")).toBe("released");
    await client.close();
  });

  it("preserves portal cancellation as a useful structured error", async () => {
    const client = new WaylandPortalClient(process.env, { source });
    await expect(client.call("setup", { fail: true }, ctx)).rejects.toMatchObject({
      code: "permission_denied", details: { mayHaveApplied: false }
    });
    await client.close();
  });

  it("selects the portal even when a Wayland session also exposes XWayland", () => {
    const backend = createLinuxBackend({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":99", PATH: "" });
    expect(backend.id).toBe("linux-wayland-portal");
    expect(backend.setupInWorker).toBe(true);
  });
});

describe.skipIf(process.platform !== "linux")("Wayland screenshot validation", () => {
  it("rejects a response bound to a different selected monitor", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=";
    const screenshotSource = source.replace("result = {'pid':os.getpid(),'session':session,'ready':ready,'operation':req['operation']}",
      `result = {'data':'${png}','mimeType':'image/png','display':{'id':'wayland:99','instanceId':session,'x':0,'y':0,'width':1,'height':1,'scaleX':1,'scaleY':1},'capturedAt':time.time()*1000}`);
    const backend = createWaylandBackend(process.env, { source: screenshotSource });
    await expect(backend.screenshot("wayland:42", ctx)).rejects.toMatchObject({ code: "invalid_screenshot_geometry" });
    const child = observed.children.at(-1)!;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await backend.close?.();
  });
});
