import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceManager, workspaceRpc, windowsWorkspaceLaunchSpec } from "../src/computer/workspace-client.js";
import type { WorkspaceBootstrap, WorkspaceEndpoint } from "../src/computer/workspace-broker.js";
import { readWorkspaceJson, writeWorkspaceJson, type WorkspaceJournal } from "../src/computer/workspace-state.js";
import type { WorkspaceProvider } from "../src/computer/workspace-types.js";
import type { PackContext } from "../src/pack.js";

const providerId = "test-private-workspace";
const temporary = mkdtempSync(join(tmpdir(), "relay-workspace-process-"));
let bundle = "";
const managers: WorkspaceManager[] = [];
const workers: ChildProcess[] = [];
const brokers: Array<{ directory: string; bootstrap: WorkspaceBootstrap }> = [];
const noLocalMutation = async (): Promise<never> => { throw new Error("provider mutation must run in independent broker"); };
const provider: WorkspaceProvider = {
  id: providerId,
  async probe() { return { available: true, isolated: true, clipboardBoundary: "isolated", canAdoptWindows: false,
    recovery: "window-moved", independentWatchdog: true, unicodeText: true }; },
  open: noLocalMutation, renew: noLocalMutation, inspect: noLocalMutation,
  capture: noLocalMutation, act: noLocalMutation, recover: noLocalMutation
};
const packContext = (): PackContext => ({ root: temporary, allowShell: false, allowKernel: false, log() {},
  caller: { ownerKey: "test-authenticated-owner", authorizationExpiresAt: Date.now() + 120000 },
  connection: { epoch: randomUUID(), authenticated: true, signal: new AbortController().signal, lastServerMessageAt: Date.now } });
async function eventually<T>(read: () => T | undefined, timeoutMs = 10000): Promise<T> {
  const end = Date.now() + timeoutMs;
  do { const result = read(); if (result !== undefined) return result; await delay(50); } while (Date.now() < end);
  throw new Error("expected workspace state did not arrive before deadline");
}
function events(directory: string): Array<Record<string, unknown>> {
  const path = join(directory, "provider-events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function createBootstrap(): Promise<{ directory: string; bootstrap: WorkspaceBootstrap }> {
  const leaseId = randomUUID(), directory = join(temporary, leaseId), now = Date.now();
  const bootstrap: WorkspaceBootstrap = { schema: 1, secret: randomBytes(32).toString("hex"),
    journal: { schema: 1, leaseId, providerId, phase: "preparing", createdAt: now, updatedAt: now,
      owner: { ownerKey: "test-authenticated-owner", connectionEpoch: randomUUID(), authorizationExpiresAt: now + 120000 },
      options: { leaseId, width: 800, height: 600, expiresAt: now + 120000, hardExpiresAt: now + 120000 } } };
  await writeWorkspaceJson(join(directory, "bootstrap.json"), bootstrap);
  brokers.push({ directory, bootstrap });
  return { directory, bootstrap };
}
async function startWorker(directory: string): Promise<{ worker: ChildProcess; brokerPid: number }> {
  const worker = spawn(process.execPath, [bundle, "worker", directory], { stdio: ["ignore", "pipe", "pipe"] });
  workers.push(worker);
  const lines = createInterface({ input: worker.stdout! });
  try {
    const message = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(String(line)) as { ready: boolean; brokerPid: number }),
      once(worker, "exit").then(() => { throw new Error("fixture worker exited before readiness"); }),
      delay(10000).then(() => { throw new Error("fixture worker startup timed out"); })
    ]);
    expect(message.ready).toBe(true);
    return { worker, brokerPid: message.brokerPid };
  } finally { lines.close(); }
}

it("constructs a GUI-hosted hidden Windows broker entry with Unicode paths and no shell expansion", () => {
  const value = windowsWorkspaceLaunchSpec("C:\\Users\\用户\\workspace", "C:\\Program Files\\Relay\\cli.cjs",
    "C:\\Program Files\\Node\\node.exe", "C:\\Windows");
  expect(value.taskExecutable).toBe("C:\\Windows\\System32\\wscript.exe");
  expect(value.taskArguments).toContain("//B");
  expect(value.launcherScript).toContain(", 0, True)");
  expect(value.launcherScript).toContain("WScript.Quit exitCode");
  expect(value.launcherScript).toContain("用户");
  const literal = value.launcherScript.match(/shell\.Run\(("(?:[^"]|"")*"), 0, True\)/)?.[1];
  expect(literal).toBeDefined();
  const command = literal!.slice(1, -1).replace(/""/g, '"');
  expect(command).toBe('"C:\\Program Files\\Node\\node.exe" "C:\\Program Files\\Relay\\cli.cjs" "workspace-broker" "--workspace-directory" "C:\\Users\\用户\\workspace"');
  expect(() => windowsWorkspaceLaunchSpec("C:\\%INJECTED%\\workspace", "C:\\relay\\cli.cjs", "C:\\node.exe", "C:\\Windows")).toThrow(/environment expansion/);
});

describe.skipIf(process.platform !== "linux")("real independent workspace broker", () => {
  beforeAll(() => {
    bundle = join(temporary, "fixture.cjs");
    buildSync({ entryPoints: [fileURLToPath(new URL("./manual/workspace-broker-fixture.ts", import.meta.url))],
      outfile: bundle, bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "silent" });
  }, 20000);
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const item of brokers.splice(0)) {
      try { await workspaceRpc(item.directory, item.bootstrap, { operation: "recover", owner: item.bootstrap.journal.owner }, { timeoutMs: 2000 }); } catch {}
    }
    for (const worker of workers.splice(0)) {
      if (worker.exitCode === null && worker.signalCode === null) {
        const stopped = once(worker, "exit");
        worker.kill("SIGTERM");
        await Promise.race([stopped, delay(5000)]);
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      }
    }
  }, 15000);

  it("authenticates ownership, preserves frame identity and defers updates until durable input revocation", async () => {
    const manager = new WorkspaceManager({ configPath: join(temporary, randomUUID(), ...Array.from({ length: 12 }, (_, index) => "deep journal directory " + index), "device.json"), provider: async () => provider, entryPoint: bundle });
    managers.push(manager);
    const context = packContext();
    const opened = await manager.session({ operation: "open", mode: "isolated", request_id: "open",
      width: 800, height: 600, idle_timeout_ms: 60000 }, context);
    const leaseId = String(opened.lease_id), directory = join(manager.directory, leaseId);
    expect(Buffer.byteLength(directory)).toBeGreaterThan(256);
    expect(opened.state).toBe("active"); expect(manager.updateBlockedReason()).toContain("workspace");
    const bootstrap = readWorkspaceJson<WorkspaceBootstrap>(join(directory, "bootstrap.json"));
    const wrong = { ...context, caller: { ...context.caller!, ownerKey: "another-authenticated-owner" } };
    await expect(manager.capture(leaseId, wrong, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "workspace_owner_mismatch" });
    const nextEpoch = { ...context, connection: { ...context.connection!, epoch: randomUUID() } };
    await expect(manager.inspect(leaseId, nextEpoch, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "workspace_owner_mismatch" });
    await expect(workspaceRpc(directory, { ...bootstrap, secret: "0".repeat(64) }, { operation: "act",
      owner: bootstrap.journal.owner, requestId: "invalid-cap", action: { type: "text", text: "forbidden" } }, { timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "workspace_broker_unavailable" });
    const capture = await manager.capture(leaseId, context, { timeoutMs: 1000 });
    expect(capture.app?.title).toBe("独立窗口 🪷"); expect(capture.display.instanceId).toBe(leaseId);
    const action = { type: "text" as const, text: "你好 🪷" };
    const first = await manager.act(leaseId, "once", action, context, { timeoutMs: 1000, expectedAppId: "private-app" });
    expect(first).toMatchObject({ applied: true, action, expectedAppId: "private-app" });
    await manager.act(leaseId, "once", action, context, { timeoutMs: 1000, expectedAppId: "private-app" });
    expect(events(directory).filter(item => item.operation === "act")).toHaveLength(1);
    await manager.revokeOwner(context.caller!.ownerKey);
    expect(readWorkspaceJson<WorkspaceJournal>(join(directory, "journal.json"))).toMatchObject({
      phase: "closed", reason: "authorization_expired", recovery: { inputRevoked: true, complete: true } });
    expect(existsSync(join(directory, "revoked.json"))).toBe(true);
    expect(manager.updateBlockedReason()).toBeUndefined();
    await expect(manager.capture(leaseId, context, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "workspace_authorization_revoked" });
  }, 20000);

  it("survives a killed relay worker outside its process session and recovers when owner heartbeats cease", async () => {
    const { directory, bootstrap } = await createBootstrap();
    const { worker, brokerPid } = await startWorker(directory);
    const stat = readFileSync("/proc/" + brokerPid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    expect(Number(fields[1])).not.toBe(worker.pid);
    expect(Number(fields[3])).toBe(brokerPid);
    const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
    expect(() => process.kill(brokerPid, 0)).not.toThrow();
    const journal = await eventually(() => {
      const value = readWorkspaceJson<WorkspaceJournal>(join(directory, "journal.json"));
      return value.phase === "closed" ? value : undefined;
    }, 22000);
    expect(journal).toMatchObject({ reason: "owner_lost", recovery: { inputRevoked: true, ownedDisplayRemoved: true } });
    expect(events(directory).filter(item => item.operation === "open")).toHaveLength(1);
    expect(events(directory).find(item => item.operation === "recover")?.reason).toBe("owner_lost");
    expect(bootstrap.journal.leaseId).toBe(journal.leaseId);
  }, 30000);

  it("restarts a crashed broker only to recover its journal and never recreates the lease", async () => {
    const manager = new WorkspaceManager({ configPath: join(temporary, randomUUID(), "device.json"), provider: async () => provider, entryPoint: bundle });
    managers.push(manager);
    const context = packContext();
    const opened = await manager.session({ operation: "open", mode: "isolated", request_id: "open-restart", idle_timeout_ms: 60000 }, context);
    const directory = join(manager.directory, String(opened.lease_id));
    const endpoint = readWorkspaceJson<WorkspaceEndpoint>(join(directory, "broker.json"));
    process.kill(endpoint.pid, "SIGKILL");
    await delay(100);
    const result = await manager.session({ operation: "close", lease_id: String(opened.lease_id), request_id: "recover-restart" }, context);
    expect(result.state).toBe("closed"); expect(result.input_allowed).toBe(false);
    expect(manager.updateBlockedReason()).toBeUndefined();
    expect(events(directory).filter(item => item.operation === "open")).toHaveLength(1);
    expect(events(directory).find(item => item.operation === "recover")?.reason).toBe("recovery");
    expect(readWorkspaceJson<WorkspaceEndpoint>(join(directory, "broker.json")).pid).not.toBe(endpoint.pid);
  }, 20000);
});
