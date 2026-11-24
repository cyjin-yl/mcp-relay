import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { runConnection, type ConnectionControl, type SupervisorMessage, type WorkerMessage } from "../src/connection.js";
import { textResult, type ToolPack } from "../src/pack.js";

function controller() {
  let listener: ((message: SupervisorMessage) => void) | undefined;
  const messages: WorkerMessage[] = [];
  const waiters = new Map<string, (message: WorkerMessage) => void>();
  const control: ConnectionControl = {
    send(message) { messages.push(message); waiters.get(message.type)?.(message); },
    subscribe(next) { listener = next; return () => { listener = undefined; }; }
  };
  return {
    control, messages,
    send(message: SupervisorMessage) { listener?.(message); },
    wait(type: WorkerMessage["type"]) {
      const prior = messages.find((message) => message.type === type);
      if (prior) return Promise.resolve(prior);
      return new Promise<WorkerMessage>((resolve) => waiters.set(type, resolve));
    }
  };
}

async function fixture(pack: ToolPack, startPaused = false) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const connected = Promise.withResolvers<WebSocket>();
  const hello = Promise.withResolvers<void>();
  const received: any[] = [];
  const responses = new Map<string, (message: any) => void>();
  server.on("connection", (socket) => {
    connected.resolve(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type === "hello") hello.resolve();
      if (message.type === "result") responses.get(message.id)?.(message);
    });
  });
  const ipc = controller();
  const running = runConnection({
    config: { url: `http://127.0.0.1:${address.port}`, token: "test-token", slug: "test-device", deviceId: "test-device" },
    root: process.cwd(), name: "test", allowShell: false, allowKernel: false,
    version: "0.1.7", log() {}, packs: [pack], control: ipc.control, startPaused
  });
  const socket = await connected.promise;
  await hello.promise;
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  return {
    ipc, running, send, received,
    ready() { send({ type: "hello_ack", deviceId: "test-device", slug: "test-device", serverTime: Date.now() }); },
    call(id: string, timeoutMs = 1000, extra: Record<string, unknown> = {}) {
      const result = new Promise<any>((resolve) => responses.set(id, resolve));
      send({ type: "call", id, tool: "work", args: {}, timeoutMs, ...extra });
      return result;
    },
    async cleanup() {
      if (socket.readyState === WebSocket.OPEN) socket.close(4003, "test cleanup");
      await running;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

it("announces readiness only after an authenticated registration acknowledgement", async () => {
  const f = await fixture({ id: "test", tools: [], async call() { return textResult(""); } });
  try {
    await delay(15);
    expect(f.ipc.messages).toEqual([]);
    f.ready();
    expect(await f.ipc.wait("relay:ready")).toMatchObject({ type: "relay:ready", version: "0.1.7", slug: "test-device" });
  } finally { await f.cleanup(); }
});

it("drains accepted work and delivers its result before shutdown; rejects new work while draining", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let executions = 0;
  const f = await fixture({
    id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    async call() { executions++; started.resolve(); await finish.promise; return textResult("committed"); }
  });
  try {
    f.ready();
    await f.ipc.wait("relay:ready");
    const completed = f.call("long");
    await started.promise;
    f.ipc.send({ type: "relay:drain", requestId: "upgrade" });
    expect(await f.call("too-late")).toMatchObject({ ok: false, error: { code: "device_updating" } });
    expect(f.ipc.messages.some((message) => message.type === "relay:drained")).toBe(false);
    const drained = f.ipc.wait("relay:drained").then(() => f.ipc.send({ type: "relay:shutdown" }));
    finish.resolve();
    await drained;
    expect(await completed).toMatchObject({ ok: true, result: { content: [{ text: "committed" }] } });
    expect(await f.running).toBe(0);
    expect(executions).toBe(1);
  } finally { finish.resolve(); await f.cleanup(); }
});

it("does not report drained while a timed-out non-cooperative operation still owns its slot", async () => {
  const finish = Promise.withResolvers<void>();
  const f = await fixture({
    id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    async call() { await finish.promise; return textResult("eventually stopped"); }
  });
  try {
    f.ready();
    expect(await f.call("expires", 25)).toMatchObject({ ok: false, error: { code: "tool_timeout" } });
    f.ipc.send({ type: "relay:drain", requestId: "upgrade" });
    await delay(20);
    expect(f.ipc.messages.some((message) => message.type === "relay:drained")).toBe(false);
    finish.resolve();
    await f.ipc.wait("relay:drained");
    f.ipc.send({ type: "relay:shutdown" });
    expect(await f.running).toBe(0);
  } finally { finish.resolve(); await f.cleanup(); }
});

it("gates a candidate until the supervisor commits it and explicitly activates it", async () => {
  let executions = 0;
  const f = await fixture({
    id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    async call() { executions++; return textResult("active"); }
  }, true);
  try {
    f.ready();
    await f.ipc.wait("relay:ready");
    expect(await f.call("before-commit")).toMatchObject({ ok: false, error: { code: "device_updating" } });
    f.ipc.send({ type: "relay:resume", requestId: "unrelated" });
    expect(await f.call("still-paused")).toMatchObject({ ok: false, error: { code: "device_updating" } });
    f.ipc.send({ type: "relay:resume", requestId: "activate-candidate" });
    expect(await f.call("after-commit")).toMatchObject({ ok: true });
    expect(executions).toBe(1);
  } finally { await f.cleanup(); }
});


it("defers without pausing service when a pack owns persistent session state", async () => {
  let blocked = true;
  const f = await fixture({
    id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    updateBlockedReason: () => blocked ? "test session is active" : undefined,
    async call() { return textResult("still available"); }
  });
  try {
    f.ready();
    f.ipc.send({ type: "relay:drain", requestId: "first" });
    expect(await f.ipc.wait("relay:drain-deferred")).toMatchObject({ requestId: "first", reason: "test session is active" });
    expect(await f.call("uninterrupted")).toMatchObject({ ok: true });
    blocked = false;
    f.ipc.send({ type: "relay:drain", requestId: "retry" });
    expect(await f.ipc.wait("relay:drained")).toMatchObject({ requestId: "retry" });
    f.ipc.send({ type: "relay:shutdown" });
    expect(await f.running).toBe(0);
  } finally { await f.cleanup(); }
});

it("rechecks session state created by an already accepted call before acknowledging drain", async () => {
  let blocked = false;
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const f = await fixture({
    id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    updateBlockedReason: () => blocked ? "late session state" : undefined,
    async call() { started.resolve(); await finish.promise; blocked = true; return textResult("state created"); }
  });
  try {
    f.ready();
    const result = f.call("creates-state");
    await started.promise;
    f.ipc.send({ type: "relay:drain", requestId: "upgrade" });
    finish.resolve();
    expect(await result).toMatchObject({ ok: true });
    expect(await f.ipc.wait("relay:drain-deferred")).toMatchObject({ requestId: "upgrade", reason: "late session state" });
    expect(f.ipc.messages.some((message) => message.type === "relay:drained")).toBe(false);
  } finally { finish.resolve(); await f.cleanup(); }
});


it("holds shutdown open until an aborted non-cooperative operation has actually stopped", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  server.on("connection", (socket) => socket.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "hello") socket.send(JSON.stringify({
      type: "call", id: "running", tool: "work", args: {}, timeoutMs: 10000
    }));
  }));
  const running = runConnection({
    config: { url: `http://127.0.0.1:${address.port}`, token: "test", deviceId: "test", slug: "test", name: "test" },
    root: process.cwd(), name: "test", allowShell: false, allowKernel: false, version: "0.1.7", log() {},
    signal: controller.signal, packs: [{
      id: "test", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
      async call() { started.resolve(); await finish.promise; return textResult("stopped"); }
    }]
  });
  let closed = false;
  running.then(() => { closed = true; });
  try {
    await started.promise;
    controller.abort();
    await delay(30);
    expect(closed).toBe(false);
    finish.resolve();
    expect(await running).toBe(0);
  } finally {
    finish.resolve();
    controller.abort();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("passes authenticated caller metadata and aborts the connection epoch independently of an individual call", async () => {
  let observed: import("../src/pack.js").PackContext | undefined;
  const closed = vi.fn(), disposed = vi.fn(async () => {});
  const f = await fixture({ id: "computer", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    connectionClosed: closed, dispose: disposed,
    async call(_name, _args, context) { observed = context; return textResult("observed"); } });
  f.ready(); await f.ipc.wait("relay:ready");
  const caller = { ownerKey: "server-authenticated-owner", authorizationExpiresAt: Date.now() + 60000 };
  await f.call("caller-context", 1000, { caller });
  expect(observed?.caller).toEqual(caller);
  expect(observed?.connection?.authenticated).toBe(true);
  expect(observed?.connection?.signal.aborted).toBe(false);
  const epoch = observed!.connection!.epoch;
  await f.cleanup();
  expect(observed?.connection?.authenticated).toBe(false);
  expect(observed?.connection?.signal.aborted).toBe(true);
  expect(closed).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledWith(epoch);
  expect(disposed).toHaveBeenCalledOnce();
});

it("delivers owner revocation while another tool still occupies the write lane", async () => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), revoked = Promise.withResolvers<string>();
  const f = await fixture({ id: "computer", tools: [{ name: "work", description: "test", inputSchema: { type: "object" } }],
    async revokeWorkspaceOwner(ownerKey) { revoked.resolve(ownerKey); },
    async call() { started.resolve(); await finish.promise; return textResult("finished"); } });
  try {
    f.ready(); await f.ipc.wait("relay:ready");
    const result = f.call("active-input");
    await started.promise;
    f.send({ type: "workspace_revoke", ownerKey: "revoked-owner" });
    expect(await revoked.promise).toBe("revoked-owner");
    finish.resolve(); await result;
  } finally { finish.resolve(); await f.cleanup(); }
});

it("defers an update while isolated workspace cleanup is pending and permits it after closure", async () => {
  let pending = true;
  const f = await fixture({ id: "computer", tools: [],
    updateBlockedReason: () => pending ? "isolated workspace cleanup pending" : undefined,
    async call() { return textResult(""); } });
  try {
    f.ready(); await f.ipc.wait("relay:ready");
    f.ipc.send({ type: "relay:drain", requestId: "workspace-update" });
    expect(await f.ipc.wait("relay:drain-deferred")).toMatchObject({ requestId: "workspace-update", reason: "isolated workspace cleanup pending" });
    expect(f.ipc.messages.some(message => message.type === "relay:drained")).toBe(false);
    pending = false;
    f.ipc.send({ type: "relay:drain", requestId: "after-cleanup" });
    expect(await f.ipc.wait("relay:drained")).toMatchObject({ requestId: "after-cleanup" });
  } finally { await f.cleanup(); }
});
