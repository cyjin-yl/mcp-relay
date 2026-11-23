// Exercise the actual npm artifact against a loopback-only protocol peer.
// Usage: node packages/device/test/packaged-smoke.mjs /path/to/installed/dist/cli.cjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

const cli = resolve(process.argv[2] ?? "packages/device/dist/cli.cjs");
const root = mkdtempSync(join(tmpdir(), "relay-package-smoke-"));
const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = join(root, "device.json");
writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, deviceId: "test-device", slug: "test-device", token: "local-test-token", name: "package-test" }));
writeFileSync(join(root, "fixture.txt"), "parallel-read-ok\n");
const hello = Promise.withResolvers();
const pending = new Map();
let socket;
let counter = 0;
server.on("connection", (peer) => {
  socket = peer;
  peer.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "hello") {
      peer.send(JSON.stringify({ type: "hello_ack", deviceId: "test-device", slug: "test-device", serverTime: Date.now() }));
      hello.resolve(message);
    } else if (message.type === "result") {
      const wait = pending.get(message.id);
      pending.delete(message.id);
      wait?.resolve(message);
    }
  });
});
const child = spawn(process.execPath, [cli, "connect", "--no-auto-update", "--config", config, "--root", root, "--packs", "minimal,omp,kernel", "--allow-kernel"], {
  env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir() }, stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
const exit = once(child, "exit");
const watchdog = setTimeout(() => child.kill("SIGKILL"), 50000);
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
function call(tool, args, timeoutMs = 2000) {
  const id = String(++counter);
  const result = Promise.withResolvers();
  pending.set(id, result);
  socket.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs }));
  return { id, result: result.promise };
}
async function waitFile(path) {
  const until = performance.now() + 5000;
  while (!existsSync(path)) {
    assert.ok(performance.now() < until, `shell did not create ${path}`);
    await delay(5);
  }
}
try {
  const announced = await Promise.race([hello.promise, exit.then(() => { throw new Error(`client exited before hello: ${logs}`); })]);
  assert.equal(announced.device.version, "0.1.7");
  for (const name of ["read", "bash", "bash_confirm", "kernel_eval", "kernel_reset"]) {
    assert.ok(announced.tools.some((tool) => tool.name === name), `missing tool ${name}`);
  }
  const started = performance.now();
  const ready = join(root, "slow-ready");
  const slow = call("bash", { command: `printf ready > ${quote(ready)}; sleep 22; printf slow-done`, timeout_ms: 25000 }, 26000);
  await waitFile(ready);
  const queued = call("write", { path: "expired.txt", content: "must-never-write" }, 50);
  const readingAt = performance.now();
  const read = await call("read", { path: "fixture.txt" }).result;
  const readMs = Math.round(performance.now() - readingAt);
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read.result), /parallel-read-ok/);
  assert.ok(readMs < 2000, `read blocked for ${readMs}ms`);
  assert.equal((await queued.result).error?.code, "tool_timeout");
  const slowResult = await slow.result;
  assert.equal(slowResult.ok, true);
  assert.match(JSON.stringify(slowResult.result), /slow-done/);
  assert.ok(performance.now() - started >= 22000);
  assert.equal(existsSync(join(root, "expired.txt")), false);

  const cancelReady = join(root, "cancel-ready");
  const trigger = join(root, "trigger");
  const late = join(root, "late.txt");
  const cancelled = call("bash", { command: `(while [ ! -f ${quote(trigger)} ]; do sleep 0.01; done; printf late > ${quote(late)}) & printf ready > ${quote(cancelReady)}; wait`, timeout_ms: 10000 }, 11000);
  await waitFile(cancelReady);
  socket.send(JSON.stringify({ type: "cancel", id: cancelled.id }));
  assert.equal((await cancelled.result).error?.code, "tool_cancelled");
  // A subsequent writer can start only after the cancelled shell has closed.
  assert.equal((await call("write", { path: "after-cancel.txt", content: "ok" }).result).ok, true);
  writeFileSync(trigger, "go");
  await delay(100);
  assert.equal(existsSync(late), false);
  assert.match(JSON.stringify((await call("kernel_eval", { code: "globalThis.packageCounter = 1" }).result).result), /1/);
  assert.match(JSON.stringify((await call("kernel_eval", { code: "++globalThis.packageCounter" }).result).result), /2/);
  console.log(JSON.stringify({ version: announced.device.version, tools: announced.tools.length, longShellMs: Math.round(performance.now() - started), concurrentReadMs: readMs, expiredWriteAbsent: true, cancelledChildSideEffectAbsent: true, persistentKernel: true }));
  socket.close(4003, "package test complete");
  assert.equal((await exit)[0], 3);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearTimeout(watchdog);
  if (child.exitCode === null) child.kill("SIGKILL");
  for (const peer of server.clients) peer.terminate();
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
