import { hostname, platform as osPlatform, arch as osArch } from "node:os";
import WebSocket from "ws";
import type { CallToolResult, JsonObject } from "@mcp-relay/shared";
import { buildExecutor } from "./executor.js";
import type { DeviceConfig } from "./config.js";
import type { PackContext, ToolPack } from "./pack.js";

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
  let current: WebSocket | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task, task);
  };

  while (true) {
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
    current = ws;

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
      if (message.type !== "call") return;
      enqueue(async () => {
        const started = Date.now();
        const id = message.id;
        try {
          const args = message.args && typeof message.args === "object" ? message.args : {};
          const timeoutMs = Math.min(Math.max(message.timeoutMs ?? 20000, 1000), 25000);
          const { promise: timeout, reject } = Promise.withResolvers<never>();
          const timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs);
          let result: CallToolResult;
          try {
            result = await Promise.race([executor.call(message.tool, args, context), timeout]);
          } finally {
            clearTimeout(timer);
          }
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "result", id, ok: true, result }));
          options.log(`${message.tool} ok ${Date.now() - started}ms`);
        } catch (error) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: "result",
              id,
              ok: false,
              error: { code: "tool_error", message: (error as Error).message }
            })
          );
          options.log(`${message.tool} error ${Date.now() - started}ms: ${(error as Error).message}`);
        }
      });
    });

    ws.on("close", (code, reason) => {
      options.log(`disconnected code=${code}${reason.length > 0 ? ` reason=${reason.toString()}` : ""}`);
      settle(code === 4001 || code === 4003 || code === 1008 ? "fatal" : "retry");
    });

    ws.on("error", (error) => {
      options.log(`socket error: ${error.message}`);
      if (ws.readyState !== WebSocket.OPEN) settle("retry");
    });

    const outcome = await promise;
    current = null;
    if (outcome === "fatal") return 3;
    attempt += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500);
    options.log(`reconnecting in ${delay}ms`);
    await sleep(delay);
  }
}

export function describeDevice(): { hostname: string; platform: string; arch: string } {
  return { hostname: hostname(), platform: osPlatform(), arch: osArch() };
}
