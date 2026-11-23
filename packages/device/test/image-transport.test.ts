import { once } from "node:events";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { MAX_DEVICE_MESSAGE_BYTES, requiredScope } from "@mcp-relay/shared";
import { runConnection } from "../src/connection.js";
import type { ToolPack } from "../src/pack.js";

async function fixture(pack: ToolPack) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: MAX_DEVICE_MESSAGE_BYTES });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const connected = Promise.withResolvers<WebSocket>();
  const ready = Promise.withResolvers<void>();
  const responses = new Map<string, (value: any) => void>();
  server.on("connection", (socket) => {
    connected.resolve(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "hello_ack", deviceId: "image-fixture", slug: "image-fixture", serverTime: Date.now() }));
        ready.resolve();
      }
      if (message.type === "result") responses.get(message.id)?.(message);
    });
  });
  const running = runConnection({
    config: { url: "http://127.0.0.1:" + address.port, token: "fixture", slug: "image-fixture", deviceId: "image-fixture" },
    root: process.cwd(), name: "fixture", allowShell: false, allowKernel: false,
    version: "fixture", log() {}, packs: [pack]
  });
  const socket = await connected.promise;
  await ready.promise;
  return {
    socket,
    call(id: string, args: Record<string, unknown> = {}, tool = "fixture") {
      const result = new Promise<any>((resolve) => responses.set(id, resolve));
      socket.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs: 3000 }));
      return result;
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN) socket.close(4003, "fixture complete");
      await running;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

it("preserves native image blocks larger than the old 1 MiB websocket limit", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64");
  const f = await fixture({
    id: "image-fixture",
    tools: [{ name: "fixture", description: "fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    async call() { return { content: [{ type: "image", data, mimeType: "image/png" }], structuredContent: { width: 1, height: 1 } }; }
  });
  try {
    const received = await f.call("image");
    expect(received).toMatchObject({ ok: true, result: { content: [{ type: "image", mimeType: "image/png", data }], structuredContent: { width: 1, height: 1 } } });
  } finally { await f.close(); }
});

it("replaces oversized UTF-8 result frames with a bounded error and keeps the connection usable", async () => {
  const f = await fixture({
    id: "limit-fixture",
    tools: [{ name: "fixture", description: "fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    async call(_name, args) { return { content: [{ type: "text", text: args.large ? "☃".repeat(8 * 1024 * 1024) : "still connected" }] }; }
  });
  try {
    expect(await f.call("large", { large: true })).toMatchObject({ ok: false, error: { code: "result_too_large" } });
    expect(f.socket.readyState).toBe(WebSocket.OPEN);
    expect(await f.call("later")).toMatchObject({ ok: true, result: { content: [{ type: "text", text: "still connected" }] } });
  } finally { await f.close(); }
});

it("requires write scope for computer mutation names even with a forged read-only annotation", () => {
  for (const name of ["computer_action", "computer_handoff", "computer_setup"]) {
    expect(requiredScope({ name, annotations: { readOnlyHint: true } })).toBe("relay.write");
  }
  expect(requiredScope({ name: "computer_screenshot", annotations: { readOnlyHint: true } })).toBe("relay.read");
});

it("dispatches write-scoped handoff while an active computer writer is still running", async () => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let actionFinished = false;
  let pauseSawActiveWriter = false;
  const f = await fixture({
    id: "handoff-fixture",
    tools: ["computer_action", "computer_handoff"].map(name => ({
      name, description: name, inputSchema: { type: "object" }, annotations: { readOnlyHint: false }
    })),
    async call(name) {
      if (name === "computer_action") {
        started.resolve();
        await released.promise;
        actionFinished = true;
        return { content: [{ type: "text", text: "action stopped" }] };
      }
      pauseSawActiveWriter = !actionFinished;
      released.resolve();
      return { content: [{ type: "text", text: "paused" }] };
    }
  });
  try {
    const action = f.call("action", {}, "computer_action");
    await started.promise;
    expect(await f.call("pause", { mode: "pause" }, "computer_handoff")).toMatchObject({ ok: true });
    expect(pauseSawActiveWriter).toBe(true);
    expect(await action).toMatchObject({ ok: true });
  } finally { released.resolve(); await f.close(); }
});
