import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join } from "node:path";
import { acquireUpdateLock } from "../updater.js";
import { ComputerError, type ComputerAction } from "./types.js";
import type { WorkspaceCloseReason, WorkspaceOwner, WorkspaceProvider } from "./workspace-types.js";
import { readWorkspaceJson, WorkspaceController, writeWorkspaceJson, type WorkspaceJournal } from "./workspace-state.js";
import { runNative } from "./native.js";

export interface WorkspaceBootstrap {
  schema: 1;
  secret: string;
  journal: WorkspaceJournal;
  /** Optional settings file contains only enable/pause booleans, never device credentials. */
  settingsPath?: string;
  taskName?: string;
}
export interface WorkspaceEndpoint { schema: 1; port: number; pid: number; providerId: string; ready: boolean }
export interface WorkspaceRpcRequest {
  secret: string;
  operation: "open" | "heartbeat" | "renew" | "inspect" | "capture" | "act" | "close" | "status" | "recover";
  owner: WorkspaceOwner;
  timeoutMs?: number;
  expectedAppId?: string;
  lastServerMessageAt?: number;
  durationMs?: number;
  action?: ComputerAction;
  requestId?: string;
  reason?: WorkspaceCloseReason;
}
const MAX_REQUEST = 128 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const equalSecret = (left: unknown, right: string) => typeof left === "string" && /^[a-f0-9]{64}$/.test(left)
  && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const publicError = (error: unknown) => ({ code: error instanceof ComputerError ? error.code : "workspace_failed",
  message: error instanceof ComputerError ? error.message : "Workspace operation failed; inspect its cleanup status." });

/** Independent process entry. No parent IPC, device configuration or bearer token is needed. */
export async function runWorkspaceBroker(directory: string, provider: WorkspaceProvider): Promise<number> {
  if (!isAbsolute(directory)) throw new Error("workspace directory must be absolute");
  const bootstrap = readWorkspaceJson<WorkspaceBootstrap>(join(directory, "bootstrap.json"));
  if (bootstrap.schema !== 1 || !/^[a-f0-9]{64}$/.test(bootstrap.secret)
    || bootstrap.journal.schema !== 1 || bootstrap.journal.providerId !== provider.id
    || !/^[a-f0-9-]{36}$/.test(bootstrap.journal.leaseId)) throw new Error("invalid workspace bootstrap");
  const unlock = await acquireUpdateLock(directory, "workspace-broker");
  const previous = existsSync(join(directory, "journal.json"))
    ? readWorkspaceJson<WorkspaceJournal>(join(directory, "journal.json")) : undefined;
  if (previous && (previous.schema !== 1 || previous.leaseId !== bootstrap.journal.leaseId
      || previous.providerId !== provider.id)) { await unlock(); throw new Error("workspace journal identity mismatch"); }
  const controller = new WorkspaceController({ directory, journal: previous ?? bootstrap.journal, provider });
  let closedAt: number | undefined;
  let ticking = false;
  let exitRequested = false;
  const finished = Promise.withResolvers<void>();
  const server = createServer(socket => {
    let incoming = "", consumed = false;
    const decoder = new StringDecoder("utf8");
    socket.setTimeout(125000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", data => {
      if (consumed) return;
      incoming += decoder.write(data);
      if (Buffer.byteLength(incoming) > MAX_REQUEST) { consumed = true; socket.destroy(); return; }
      const newline = incoming.indexOf("\n");
      if (newline < 0) return;
      consumed = true;
      let request: WorkspaceRpcRequest;
      try { request = JSON.parse(incoming.slice(0, newline)) as WorkspaceRpcRequest; }
      catch { socket.destroy(); return; }
      if (!equalSecret(request.secret, bootstrap.secret)) { socket.destroy(); return; }
      const respond = (value: unknown) => {
        const encoded = JSON.stringify(value) + "\n";
        if (Buffer.byteLength(encoded) > MAX_RESPONSE) { socket.end(JSON.stringify({ ok: false, error: { code: "workspace_result_too_large", message: "Workspace result exceeded its transport bound." } }) + "\n"); return; }
        socket.end(encoded);
      };
      void (async () => {
        // Recovery is a local capability operation and only revokes access.
        if (request.operation !== "recover") controller.authorize(request.owner, request.operation !== "status");
        if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120000)) throw new ComputerError("workspace_invalid_timeout", "Invalid workspace operation timeout.");
        if (request.expectedAppId !== undefined && (typeof request.expectedAppId !== "string" || request.expectedAppId.length > 4096)) throw new ComputerError("workspace_invalid_target", "Invalid expected application identity.");
        const timeout = request.timeoutMs ?? 30000;
        switch (request.operation) {
          case "open": return controller.open();
          case "heartbeat": controller.heartbeat(request.owner, request.lastServerMessageAt ?? 0); return { ok: true };
          case "renew": return controller.renew(request.owner, request.durationMs ?? 120000);
          case "status": return controller.status();
          case "inspect": return controller.inspect(timeout, request.expectedAppId);
          case "capture": {
            const screen = await controller.capture(timeout, request.expectedAppId);
            return { ...screen, data: screen.data.toString("base64") };
          }
          case "act": {
            if (!request.action || !request.requestId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.requestId)) throw new ComputerError("workspace_invalid_action", "Workspace action needs a valid request ID and action.");
            return controller.act(request.requestId, request.action, timeout, request.expectedAppId);
          }
          case "close": return controller.close(request.reason ?? "explicit");
          case "recover": return controller.close(request.reason ?? "recovery");
          default: throw new ComputerError("workspace_unknown_operation", "Unknown workspace broker operation.");
        }
      })().then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: publicError(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); await unlock(); throw new Error("workspace broker did not bind"); }
  // The broker is independently running before a client can request creation.
  await writeWorkspaceJson(join(directory, "broker.json"), {
    schema: 1, port: address.port, pid: process.pid, providerId: provider.id, ready: true
  } satisfies WorkspaceEndpoint);
  if ((previous && previous.phase !== "closed") || existsSync(join(directory, "revoked.json"))) await controller.close("recovery");
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (bootstrap.settingsPath && controller.journal.phase !== "closed") {
        try {
          const settings = readWorkspaceJson<{ enabled?: boolean; paused?: boolean }>(bootstrap.settingsPath);
          if (settings.enabled === false || settings.paused === true) await controller.close("disabled");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") await controller.close("disabled");
        }
      }
      await controller.tick();
      if (controller.journal.phase === "closed") {
        closedAt ??= Date.now();
        if (exitRequested || Date.now() - closedAt >= 5000) finished.resolve();
      }
    } finally { ticking = false; }
  };
  const timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
  const stop = () => { exitRequested = true; void controller.close("owner_lost").then(() => tick()); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    await tick();
    await finished.promise;
    return 0;
  } finally {
    clearInterval(timer);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeWorkspaceJson(join(directory, "broker.json"), { schema: 1, port: address.port, pid: process.pid, providerId: provider.id, ready: false });
    await unlock();
    if (process.platform === "win32" && bootstrap.taskName && /^MyDevices-Workspace-[a-f0-9-]{36}$/.test(bootstrap.taskName)) {
      const script = "$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskPath '\\' -TaskName '" + bootstrap.taskName
        + "' -ErrorAction SilentlyContinue; if ($task -and $task.Description -eq 'My Devices isolated workspace broker "
        + bootstrap.journal.leaseId + "') { Unregister-ScheduledTask -TaskPath '\\' -TaskName '" + bootstrap.taskName + "' -Confirm:$false }";
      try {
        await runNative({ command: join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }, { timeoutMs: 10000 });
      } catch { /* Closed journal and disabled endpoint remain; only our task registration may need reconciliation. */ }
    }
  }
}
