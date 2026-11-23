import { hostname, platform as osPlatform, arch as osArch } from "node:os";
import WebSocket from "ws";
import type { CallToolResult, JsonObject } from "@mcp-relay/shared";
import { buildExecutor } from "./executor.js";
import type { DeviceConfig } from "./config.js";
import type { PackContext, ToolPack } from "./pack.js";
import { CallScheduler } from "./scheduler.js";

export type ConnectionOptions = {
  config: DeviceConfig;
  root: string;
  name: string;
  packs: ToolPack[];
  allowShell: boolean;
  allowKernel: boolean;
  version: string;
  log: (message: string) => void;
};

type DeviceMessage =
  | { type: "hello_ack"; deviceId: string; slug: string; serverTime: number }
  | { type: "ping" }
  | { type: "cancel"; id: string }
  | { type: "call"; id: string; tool: string; args?: JsonObject; timeoutMs?: number };

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function runConnection(options: ConnectionOptions): Promise<number> {
  const executor = buildExecutor(options.packs);
  const fileState = new Map<string, string>();
  const context: PackContext = {
    root: options.root,
    allowShell: options.allowShell,
    allowKernel: options.allowKernel,
    fileState,
    log: options.log
  };
  const wsUrl = new URL("/device/ws", options.config.url);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.search = "";
  wsUrl.hash = "";

  let attempt = 0;
  const readOnlyTools = new Set(executor.tools
    .filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
  // The executor and kernel survive reconnects. Keep their writer lane too:
  // an old non-cooperative operation must finish before new mutations run.
  const scheduler = new CallScheduler<CallToolResult>();

  while (true) {
    const callIds = new Set<string>();
    const cancelSessionCalls = () => {
      for (const id of callIds) scheduler.cancel(id);
      callIds.clear();
    };
    const { promise, resolve } = Promise.withResolvers<"retry" | "fatal">();
    let settled = false;
    const settle = (value: "retry" | "fatal"): void => {
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

    ws.on("open", () => {
      attempt = 0;
      options.log(`connected as ${options.config.slug}`);
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: 1,
          device: {
            name: options.name,
            platform: osPlatform(),
            arch: osArch(),
            version: options.version,
            packs: options.packs.map((pack) => pack.id)
          },
          tools: executor.tools
        })
      );
    });

    ws.on("unexpected-response", (_request, response) => {
      options.log(`relay rejected the device token (HTTP ${response.statusCode}); run again with a new --code`);
      settle("fatal");
      ws.terminate();
    });

    ws.on("message", (raw) => {
      let message: DeviceMessage;
      try {
        message = JSON.parse(raw.toString()) as DeviceMessage;
      } catch {
        return;
      }
      if (message.type === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "hello_ack") {
        options.log(`relay registered device ${message.slug}`);
        return;
      }
      if (message.type === "cancel") {
        if (callIds.has(message.id)) scheduler.cancel(message.id);
        return;
      }
      if (message.type !== "call") return;
      if (settled || ws.readyState !== WebSocket.OPEN || callIds.has(message.id)) return;
      callIds.add(message.id);
      const receivedAt = Date.now();
      // This is the remaining transport budget, after the relay's send queue.
      // It can be below the user-facing shell minimum; never enlarge it.
      const requestedTimeout = message.timeoutMs ?? 20000;
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, 125000) : 0;
      const args = message.args && typeof message.args === "object" ? message.args : {};
      void scheduler.schedule(message.id, readOnlyTools.has(message.tool), timeoutMs,
        (signal) => executor.call(message.tool, args, { ...context, signal }))
      .then((result) => {
        const id = message.id;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "result", id, ok: true, result }));
        options.log(`${message.tool} ok ${Date.now() - receivedAt}ms`);
      }).catch((error: Error & { code?: string }) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            ok: false,
            error: { code: error.code ?? "tool_error", message: error.message }
          })
        );
        options.log(`${message.tool} error ${Date.now() - receivedAt}ms: ${error.message}`);
      }).finally(() => callIds.delete(message.id));
    });

    ws.on("close", (code, reason) => {
      cancelSessionCalls();
      options.log(`disconnected code=${code}${reason.length > 0 ? ` reason=${reason.toString()}` : ""}`);
      settle(code === 4001 || code === 4003 || code === 1008 ? "fatal" : "retry");
    });

    ws.on("error", (error) => {
      options.log(`socket error: ${error.message}`);
      if (ws.readyState !== WebSocket.OPEN) settle("retry");
    });

    const outcome = await promise;
    cancelSessionCalls();
    if (outcome === "fatal") {
      scheduler.close();
      return 3;
    }
    attempt += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500);
    options.log(`reconnecting in ${delay}ms`);
    await sleep(delay);
  }
}

export function describeDevice(): { hostname: string; platform: string; arch: string } {
  return { hostname: hostname(), platform: osPlatform(), arch: osArch() };
}
