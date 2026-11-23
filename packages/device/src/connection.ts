import { hostname, platform as osPlatform, arch as osArch } from "node:os";
import WebSocket from "ws";
import { MAX_DEVICE_MESSAGE_BYTES, type CallToolResult, type JsonObject } from "@mcp-relay/shared";
import { buildExecutor } from "./executor.js";
import type { DeviceConfig } from "./config.js";
import type { PackContext, ToolPack } from "./pack.js";
import { CallScheduler } from "./scheduler.js";

export type SupervisorMessage =
  | { type: "relay:drain"; requestId: string }
  | { type: "relay:resume"; requestId: string }
  | { type: "relay:shutdown" };

export type WorkerMessage =
  | { type: "relay:ready"; version: string; slug: string }
  | { type: "relay:drained"; requestId: string }
  | { type: "relay:drain-deferred"; requestId: string; reason: string };

export type ConnectionControl = {
  send: (message: WorkerMessage) => void;
  subscribe: (listener: (message: SupervisorMessage) => void) => () => void;
};

export type ConnectionOptions = {
  config: DeviceConfig;
  root: string;
  name: string;
  packs: ToolPack[];
  allowShell: boolean;
  allowKernel: boolean;
  version: string;
  log: (message: string) => void;
  control?: ConnectionControl;
  startPaused?: boolean;
  signal?: AbortSignal;
};

type DeviceMessage =
  | { type: "hello_ack"; deviceId: string; slug: string; serverTime: number }
  | { type: "ping" }
  | { type: "cancel"; id: string }
  | { type: "call"; id: string; tool: string; args?: JsonObject; timeoutMs?: number };

export async function runConnection(options: ConnectionOptions): Promise<number> {
  const executor = buildExecutor(options.packs);
  const fileState = new Map<string, string>();
  const context: PackContext = {
    root: options.root, allowShell: options.allowShell, allowKernel: options.allowKernel,
    fileState, log: options.log
  };
  const wsUrl = new URL("/device/ws", options.config.url);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.search = "";
  wsUrl.hash = "";

  let attempt = 0;
  const readOnlyTools = new Set(executor.tools
    .filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
  // Executor state and the writer lane survive reconnects. A cancelled,
  // non-cooperative operation still owns its slot until it actually returns.
  const scheduler = new CallScheduler<CallToolResult>();
  let drainRequest: string | undefined;
  let drainAcknowledged = false;
  let shutdownRequested = false;
  let stopping = false;
  let pendingSends = 0;
  let pendingResults = 0;
  let activationPending = options.startPaused === true;
  let stopCurrentSession: (() => void) | undefined;
  let wakeRetry: (() => void) | undefined;

  const notifyQuiescent = (): void => {
    if (!drainRequest || scheduler.pendingCount !== 0 || pendingSends !== 0 || pendingResults !== 0) return;
    // A previously queued kernel call can create state after the drain request.
    // Recheck at actual quiescence before authorizing the worker replacement.
    const blocked = options.packs.map((pack) => pack.updateBlockedReason?.()).find(Boolean);
    if (blocked && !drainAcknowledged) {
      const requestId = drainRequest;
      drainRequest = undefined;
      shutdownRequested = false;
      options.log(`update deferred: ${blocked}`);
      options.control?.send({ type: "relay:drain-deferred", requestId, reason: blocked });
      return;
    }
    if (!drainAcknowledged) {
      drainAcknowledged = true;
      options.control?.send({ type: "relay:drained", requestId: drainRequest });
    }
    if (shutdownRequested) {
      stopping = true;
      stopCurrentSession?.();
      wakeRetry?.();
    }
  };
  const unsubscribeIdle = scheduler.onIdle(notifyQuiescent);
  const unsubscribeControl = options.control?.subscribe((message) => {
    if (message.type === "relay:drain" && typeof message.requestId === "string") {
      const blocked = options.packs.map((pack) => pack.updateBlockedReason?.()).find(Boolean);
      if (blocked) {
        options.log(`update deferred: ${blocked}`);
        options.control?.send({ type: "relay:drain-deferred", requestId: message.requestId, reason: blocked });
        return;
      }
      drainRequest = message.requestId;
      drainAcknowledged = false;
      shutdownRequested = false;
      notifyQuiescent();
    } else if (message.type === "relay:resume" && activationPending && /^activate-/.test(message.requestId) && !stopping) {
      activationPending = false;
    } else if (message.type === "relay:resume" && message.requestId === drainRequest && !stopping) {
      drainRequest = undefined;
      drainAcknowledged = false;
      shutdownRequested = false;
    } else if (message.type === "relay:shutdown" && drainRequest && drainAcknowledged) {
      // Shutdown is only legal after a successful drain. A supervisor must
      // resume and postpone an update if a user's task exceeds its drain budget.
      shutdownRequested = true;
      notifyQuiescent();
    }
  });

  const onAbort = () => {
    stopping = true;
    scheduler.close();
    stopCurrentSession?.();
    wakeRetry?.();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    while (!stopping) {
      const callIds = new Set<string>();
      const cancelSessionCalls = () => {
        for (const id of callIds) scheduler.cancel(id);
        callIds.clear();
      };
      const { promise, resolve } = Promise.withResolvers<"retry" | "fatal" | "stopped">();
      let settled = false;
      const settle = (value: "retry" | "fatal" | "stopped"): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      options.log(`connecting to ${wsUrl.href}`);
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${options.config.token}` },
        handshakeTimeout: 15000,
        maxPayload: 1024 * 1024
      });
      stopCurrentSession = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "device update");
          const timer = setTimeout(() => ws.terminate(), 2000);
          timer.unref();
          ws.once("close", () => clearTimeout(timer));
        } else {
          ws.terminate();
          settle("stopped");
        }
      };

      const send = (payload: unknown): Promise<void> => {
        if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
        let data = JSON.stringify(payload);
        if (Buffer.byteLength(data, "utf8") > MAX_DEVICE_MESSAGE_BYTES) {
          const envelope = payload as { type?: unknown; id?: unknown };
          options.log("outbound message exceeds the 20 MiB WebSocket limit");
          if (envelope.type === "result" && typeof envelope.id === "string") {
            data = JSON.stringify({
              type: "result", id: envelope.id, ok: false,
              error: { code: "result_too_large", message: "device result exceeds the 20 MiB WebSocket limit" }
            });
          }
          if (Buffer.byteLength(data, "utf8") > MAX_DEVICE_MESSAGE_BYTES) {
            ws.close(1009, "outbound message too large");
            return Promise.resolve();
          }
        }
        pendingSends++;
        return new Promise<void>((done) => {
          let completed = false;
          const finish = (error?: Error) => {
            if (completed) return;
            completed = true;
            ws.off("close", onClose);
            pendingSends--;
            if (error) options.log(`socket send failed: ${error.message}`);
            done();
            notifyQuiescent();
          };
          const onClose = () => finish();
          ws.once("close", onClose);
          try { ws.send(data, (error) => finish(error)); }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
      };

      ws.on("open", () => {
        attempt = 0;
        options.log(`connected as ${options.config.slug}`);
        void send({
          type: "hello", protocol: 1,
          device: {
            name: options.name, platform: osPlatform(), arch: osArch(),
            version: options.version, packs: options.packs.map((pack) => pack.id)
          },
          tools: executor.tools
        });
      });

      ws.on("unexpected-response", (_request, response) => {
        options.log(`relay rejected the device token (HTTP ${response.statusCode}); run again with a new --code`);
        settle("fatal");
        ws.terminate();
      });

      ws.on("message", (raw) => {
        let message: DeviceMessage;
        try { message = JSON.parse(raw.toString()) as DeviceMessage; }
        catch { return; }
        if (message.type === "ping") { void send({ type: "pong" }); return; }
        if (message.type === "hello_ack") {
          if (message.deviceId !== options.config.deviceId || message.slug !== options.config.slug) {
            options.log("relay returned a mismatched device identity");
            settle("fatal");
            ws.terminate();
            return;
          }
          options.log(`relay registered device ${message.slug}`);
          options.control?.send({ type: "relay:ready", version: options.version, slug: message.slug });
          return;
        }
        if (message.type === "cancel") {
          if (callIds.has(message.id)) scheduler.cancel(message.id);
          return;
        }
        if (message.type !== "call" || settled || ws.readyState !== WebSocket.OPEN || callIds.has(message.id)) return;
        if (drainRequest || activationPending) {
          void send({
            type: "result", id: message.id, ok: false,
            error: { code: "device_updating", message: "device is preparing an update; retry shortly" }
          });
          return;
        }
        callIds.add(message.id);
        pendingResults++;
        const receivedAt = Date.now();
        const requestedTimeout = message.timeoutMs ?? 20000;
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, 125000) : 0;
        const args = message.args && typeof message.args === "object" ? message.args : {};
        // Handoff is a control operation that must be able to cancel an active UI writer.
        // Its descriptor and server authorization remain write-scoped.
        const concurrentControl = message.tool === "computer_handoff";
        void scheduler.schedule(message.id, readOnlyTools.has(message.tool) || concurrentControl, timeoutMs,
          (signal) => executor.call(message.tool, args, { ...context, signal }))
          .then(async (result) => {
            await send({ type: "result", id: message.id, ok: true, result });
            options.log(`${message.tool} ok ${Date.now() - receivedAt}ms`);
          }).catch(async (error: Error & { code?: string }) => {
            await send({
              type: "result", id: message.id, ok: false,
              error: { code: error.code ?? "tool_error", message: error.message }
            });
            options.log(`${message.tool} error ${Date.now() - receivedAt}ms: ${error.message}`);
          }).finally(() => {
            callIds.delete(message.id);
            pendingResults--;
            notifyQuiescent();
          });
      });

      ws.on("close", (code, reason) => {
        cancelSessionCalls();
        options.log(`disconnected code=${code}${reason.length > 0 ? ` reason=${reason.toString()}` : ""}`);
        settle(stopping ? "stopped" : code === 4001 || code === 4003 || code === 1008 ? "fatal" : "retry");
      });
      ws.on("error", (error) => {
        options.log(`socket error: ${error.message}`);
        if (ws.readyState !== WebSocket.OPEN) settle(stopping ? "stopped" : "retry");
      });

      const outcome = await promise;
      stopCurrentSession = undefined;
      cancelSessionCalls();
      if (outcome === "stopped" || stopping) return 0;
      if (outcome === "fatal") return 3;
      attempt++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500);
      options.log(`reconnecting in ${delay}ms`);
      await new Promise<void>((resolveRetry) => {
        const timer = setTimeout(resolveRetry, delay);
        wakeRetry = () => { clearTimeout(timer); resolveRetry(); };
        if (stopping) wakeRetry();
      });
      wakeRetry = undefined;
    }
    return 0;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribeControl?.();
    unsubscribeIdle();
    scheduler.close();
    // Keep the process-generation lock until aborted operations really finish.
    await scheduler.waitForIdle();
  }
}

export function describeDevice(): { hostname: string; platform: string; arch: string } {
  return { hostname: hostname(), platform: osPlatform(), arch: osArch() };
}
