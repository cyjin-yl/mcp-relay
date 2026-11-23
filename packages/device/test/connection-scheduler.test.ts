import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { runConnection } from "../src/connection.js";
import { textResult } from "../src/pack.js";

it("keeps the kernel writer lane across a real websocket reconnect", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const oldRun = Promise.withResolvers<ReturnType<typeof textResult>>();
  const oldStarted = Promise.withResolvers<void>();
  const newConnected = Promise.withResolvers<void>();
  const newResult = Promise.withResolvers<void>();
  const sockets: WebSocket[] = [];
  let executions = 0;
  server.on("connection", (socket) => {
    sockets.push(socket);
    const attempt = sockets.length;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "call", id: attempt === 1 ? "old" : "new", tool: "kernel_eval", args: {}, timeoutMs: 10000 }));
        if (attempt === 2) newConnected.resolve();
      }
      if (message.type === "result" && message.id === "new") newResult.resolve();
    });
  });
  const running = runConnection({
    config: { url: `http://127.0.0.1:${address.port}`, token: "test-token", slug: "test-device", deviceId: "test-device" },
    root: process.cwd(), name: "test-device", allowShell: false, allowKernel: true,
    version: "test", log() {}, packs: [{
      id: "test", tools: [{ name: "kernel_eval", description: "test serialized kernel", inputSchema: { type: "object" } }],
      async call() {
        executions++;
        if (executions === 1) { oldStarted.resolve(); return oldRun.promise; }
        return textResult("second owner");
      }
    }]
  });
  try {
    await oldStarted.promise;
    sockets[0]!.close(1012, "test reconnect");
    await newConnected.promise;
    await delay(30);
    expect(executions).toBe(1);
    oldRun.resolve(textResult("old owner stopped"));
    await newResult.promise;
    expect(executions).toBe(2);
    sockets[1]!.close(4003, "test complete");
    expect(await running).toBe(3);
  } finally {
    oldRun.resolve(textResult("cleanup"));
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close(4003, "test cleanup");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it("does not enlarge a subsecond remaining relay budget", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const observed = Promise.withResolvers<{ ok: boolean; error?: { code: string } }>();
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") socket.send(JSON.stringify({ type: "call", id: "short", tool: "slow", args: {}, timeoutMs: 25 }));
      if (message.type === "result") {
        observed.resolve(message);
        socket.close(4003, "test complete");
      }
    });
  });
  const running = runConnection({
    config: { url: `http://127.0.0.1:${address.port}`, token: "test-token", slug: "test-device", deviceId: "test-device" },
    root: process.cwd(), name: "test-device", allowShell: false, allowKernel: false,
    version: "test", log() {}, packs: [{
      id: "test", tools: [{ name: "slow", description: "test", inputSchema: { type: "object" } }],
      async call(_name, _args, ctx) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(textResult("should have expired")), 100);
          ctx.signal!.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(textResult("aborted"));
          }, { once: true });
        });
      }
    }]
  });
  try {
    expect(await observed.promise).toMatchObject({ ok: false, error: { code: "tool_timeout" } });
    expect(await running).toBe(3);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 5000);
