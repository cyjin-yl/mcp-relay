import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { spawn as spawnType } from "node:child_process";
import { createAndroidWorkspaceProvider, validateAndroidWorkspaceOptions } from "../src/computer/workspace-android.js";
import { ANDROID_WORKSPACE_HELPER } from "../src/computer/android-workspace.generated.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext } from "../src/computer/workspace-types.js";

const roots: string[] = [];
const children: EventEmitter[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.emit("exit", 0, null);
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const options = (now = 100_000): WorkspaceOpenOptions => ({
  leaseId: "lease_testing_123", width: 640, height: 480, expiresAt: now + 30_000, hardExpiresAt: now + 60_000
});
async function fixture(flags = 6536) {
  const home = await mkdtemp(join(tmpdir(), "relay-android-workspace-")); roots.push(home);
  const events: string[] = [], renewals: number[] = [];
  let wall = 100_000, clock = 500;
  const run = vi.fn(async () => ({ exitCode: 0, stderr: Buffer.alloc(0),
    stdout: Buffer.from(JSON.stringify({ event: "probe", available: true, root: true, sdk: 34 }) + "\n") }));
  const spawn = vi.fn(() => {
    events.push("spawn");
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    children.push(child);
    const stdout = new PassThrough(), stderr = new PassThrough();
    let initialized = false, ended = false, buffer = "";
    const reply = (value: unknown) => queueMicrotask(() => stdout.write(JSON.stringify(value) + "\n"));
    const stdin = new Writable({ write(chunk, _encoding, done) {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const request = JSON.parse(line);
        if (!initialized) {
          initialized = true;
          const name = "mcp-relay-workspace:" + request.leaseId + ":" + request.instanceId;
          reply({ event: "ready", leaseId: request.leaseId, instanceId: request.instanceId, pid: 1234, imePolicy: 2,
            display: { id: 17, uniqueId: "virtual:" + name, name, flags, removeMode: 0, width: request.width, height: request.height } });
        } else if (request.op === "close" && !ended) {
          ended = true; events.push("revoked");
          queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); });
        } else if (request.op === "renew") {
          renewals.push(request.ttlMs); reply({ id: request.id, ok: true, result: { remainingMs: request.ttlMs } });
        } else if (request.op === "act") events.push("act-pending");
      }
      done();
    } });
    Object.assign(child, { stdin, stdout, stderr, pid: 1001, exitCode: null, signalCode: null });
    return child;
  });
  const provider = createAndroidWorkspaceProvider({
    home, android: true, now: () => wall, monotonic: () => clock,
    run, spawn: spawn as unknown as typeof spawnType, find: () => "/system/bin/su"
  });
  const journalDirectory = join(home, "lease"); await mkdir(journalDirectory, { mode: 0o700 });
  const context: WorkspaceProviderContext = {
    journalDirectory, revocationPath: join(journalDirectory, "revoked.json"), timeoutMs: 1000,
    checkpoint: async resource => { events.push("checkpoint:" + resource.data.phase); }
  };
  return { provider, context, home, run, spawn, events, renewals, advance: (ms: number) => { clock += ms; },
    setWall: (value: number) => { wall = value; } };
}

describe("Android private workspace safety boundaries", () => {
  it("refuses task adoption, generic shell commands, oversized displays and invalid deadlines", () => {
    expect(() => validateAndroidWorkspaceOptions(options(), 100_000)).not.toThrow();
    expect(() => validateAndroidWorkspaceOptions({ ...options(), windowIds: ["existing-task"] }, 100_000)).toThrow(/adopt/);
    expect(() => validateAndroidWorkspaceOptions({ ...options(), launch: { executable: "sh", args: ["-c", "anything"] } }, 100_000)).toThrow(/component/);
    expect(() => validateAndroidWorkspaceOptions({ ...options(), width: 4096, height: 4096 }, 100_000)).toThrow(/megapixels/);
    expect(() => validateAndroidWorkspaceOptions({ ...options(), expiresAt: 100_000 }, 100_000)).toThrow(/deadline/);
  });

  it("probe is read-only and requires explicit setup before native execution", async () => {
    const test = await fixture();
    expect(await test.provider.probe(test.context)).toMatchObject({ available: false, isolated: false });
    expect(test.run).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
    await expect(readFile(join(test.home, ".mcp-relay/native/android-workspace/workspace-" + ANDROID_WORKSPACE_HELPER.sha256 + ".jar"))).rejects.toMatchObject({ code: "ENOENT" });
    await test.provider.setup!(test.context);
    expect(await test.provider.probe(test.context)).toMatchObject({ available: true, isolated: true, clipboardBoundary: "shared-app-state", unicodeText: false });
    expect(test.run.mock.calls).toHaveLength(2);
  });

  it("refuses a changed helper artifact before creating a privileged owner", async () => {
    const test = await fixture();
    await test.provider.setup!(test.context);
    const path = join(test.home, ".mcp-relay/native/android-workspace/workspace-" + ANDROID_WORKSPACE_HELPER.sha256 + ".jar");
    await writeFile(path, "tampered");
    const restarted = createAndroidWorkspaceProvider({ home: test.home, android: true, run: test.run, spawn: test.spawn as unknown as typeof spawnType, find: () => "/system/bin/su", now: () => 100_000 });
    await expect(restarted.open(options(), test.context)).rejects.toThrow(/artifact/);
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("journals ownership before creation and rejects a display missing independent focus flags", async () => {
    const test = await fixture(6536 & ~(1 << 12));
    await test.provider.setup!(test.context);
    await expect(test.provider.open(options(), test.context)).rejects.toThrow(/independent-focus/);
    expect(test.events.indexOf("checkpoint:intent")).toBeLessThan(test.events.indexOf("spawn"));
    expect(test.events).toContain("revoked");
  });

  it("same-expiry heartbeats cannot extend a lease after the wall clock moves backward", async () => {
    const test = await fixture();
    await test.provider.setup!(test.context);
    const resource = await test.provider.open(options(), test.context);
    await test.provider.renew(resource, 130_000, test.context);
    test.setWall(1_000); test.advance(1000);
    await test.provider.renew(resource, 130_000, test.context);
    expect(test.renewals).toEqual([30_000, 29_000]);
  });

  it("revokes the native owner before reporting a cancelled in-flight action", async () => {
    const test = await fixture();
    await test.provider.setup!(test.context);
    const resource = await test.provider.open(options(), test.context);
    const controller = new AbortController();
    const action = test.provider.act(resource, { type: "drag", fromX: 1, fromY: 1, toX: 2, toY: 2 }, { timeoutMs: 1000, signal: controller.signal });
    const observed = action.catch(error => { test.events.push("rejected"); throw error; });
    controller.abort();
    await expect(observed).rejects.toMatchObject({ code: "cancelled" });
    expect(test.events.indexOf("revoked")).toBeLessThan(test.events.indexOf("rejected"));
  });
});
