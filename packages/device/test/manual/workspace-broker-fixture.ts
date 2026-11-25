import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runWorkspaceBroker, type WorkspaceBootstrap, type WorkspaceEndpoint } from "../../src/computer/workspace-broker.js";
import { launchIndependentWorkspaceBroker, workspaceRpc } from "../../src/computer/workspace-client.js";
import { readWorkspaceJson } from "../../src/computer/workspace-state.js";
import type { WorkspaceProvider, WorkspaceResource } from "../../src/computer/workspace-types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=", "base64");
const providerId = "test-private-workspace";
const event = (directory: string, value: unknown) => appendFileSync(join(directory, "provider-events.jsonl"), JSON.stringify(value) + "\n");
const provider: WorkspaceProvider = {
  id: providerId,
  async probe() { return { available: true, isolated: true, clipboardBoundary: "isolated", canAdoptWindows: false,
    recovery: "window-moved", independentWatchdog: true, unicodeText: true }; },
  async open(options, context) {
    if (!existsSync(join(context.journalDirectory, "journal.json")) || !existsSync(join(context.journalDirectory, "broker.json"))) {
      throw new Error("resource creation preceded durable intent or independent readiness");
    }
    if (existsSync(context.revocationPath)) throw new Error("resource creation was revoked");
    const resource: WorkspaceResource = { providerId, leaseId: options.leaseId, instanceId: options.leaseId,
      display: { id: "private", instanceId: options.leaseId, x: 0, y: 0, width: 1, height: 1 },
      data: { directory: context.journalDirectory } };
    await context.checkpoint(resource);
    event(context.journalDirectory, { operation: "open", leaseId: resource.leaseId });
    return resource;
  },
  async renew() {},
  async inspect(resource, context) { return { platform: process.platform, backend: providerId, available: true,
    displayKind: "virtual", inputKind: "mouse_keyboard", displays: [resource.display], actions: ["text", "click"],
    unicodeText: true, permissions: {}, app: { id: "private-app", title: "独立窗口 🪷" },
    details: { expectedAppId: context.expectedAppId } }; },
  async capture(resource) { return { data: png, mimeType: "image/png", display: resource.display,
    capturedAt: Date.now(), app: { id: "private-app", title: "独立窗口 🪷" } }; },
  async act(resource, action, context) {
    event(String(resource.data.directory), { operation: "act", action, expectedAppId: context.expectedAppId });
    return { applied: true, action, expectedAppId: context.expectedAppId };
  },
  async recover(resource, options, reason, context) {
    if (!existsSync(context.revocationPath)) throw new Error("native recovery preceded durable revocation");
    event(context.journalDirectory, { operation: "recover", leaseId: options.leaseId, reason, hadResource: Boolean(resource) });
    return { complete: true, outcome: "window-moved", inputRevoked: true, ownedDisplayRemoved: true };
  }
};

async function main() {
  const directoryIndex = process.argv.indexOf("--workspace-directory");
  const directory = directoryIndex >= 0 ? process.argv[directoryIndex + 1]! : process.argv[3]!;
  if (process.argv[2] === "workspace-broker") { process.exitCode = await runWorkspaceBroker(directory, provider); return; }
  if (process.argv[2] !== "worker") throw new Error("unsupported fixture operation");
  const bootstrap = readWorkspaceJson<WorkspaceBootstrap>(join(directory, "bootstrap.json"));
  await launchIndependentWorkspaceBroker(directory, bootstrap, process.argv[1]!);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await workspaceRpc(directory, bootstrap, { operation: "status", owner: bootstrap.journal.owner }, { timeoutMs: 250 }); ready = true; break; }
    catch { await delay(50); }
  }
  if (!ready) throw new Error("independent broker did not start");
  const heartbeat = async () => workspaceRpc(directory, bootstrap, { operation: "heartbeat",
    owner: bootstrap.journal.owner, lastServerMessageAt: Date.now() }, { timeoutMs: 500 });
  await heartbeat();
  const timer = setInterval(() => { void heartbeat().catch(() => {}); }, 2000);
  const result = await workspaceRpc(directory, bootstrap, { operation: "open", owner: bootstrap.journal.owner });
  const endpoint = readWorkspaceJson<WorkspaceEndpoint>(join(directory, "broker.json"));
  process.stdout.write(JSON.stringify({ ready: true, brokerPid: endpoint.pid, result }) + "\n");
  process.on("SIGTERM", () => {
    clearInterval(timer);
    void workspaceRpc(directory, bootstrap, { operation: "recover", owner: bootstrap.journal.owner, reason: "owner_lost" })
      .finally(() => process.exit(0));
  });
}
void main().catch(() => { process.stderr.write("workspace broker fixture failed\n"); process.exitCode = 1; });
