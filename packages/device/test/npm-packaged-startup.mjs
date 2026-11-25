// Exercise an installed npm bin against a TLS loopback peer with automatic updates enabled.
// Usage: node packages/device/test/npm-packaged-startup.mjs /path/to/bin/mcp-relay /path/to/dist/cli.cjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

const bin = resolve(process.argv[2]);
const bundle = realpathSync(resolve(process.argv[3]));
const runtimeVersion = "0.1.11";
const expectedSha256 = "8b64aba92d8e72e254c4aac0707beb32a09bad4adfe174151fa6d71c0bcab15f";
const digest = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(digest(readFileSync(bundle)), expectedSha256, "Use the unchanged official runtime");
const temporary = mkdtempSync(join(tmpdir(), "relay npm 启动 space-"));
const root = join(temporary, "tool root 空间");
mkdirSync(root);
const key = join(temporary, "fixture-key.pem");
const cert = join(temporary, "fixture-cert.pem");
const openssl = spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert
], { encoding: "utf8", timeout: 10000 });
assert.equal(openssl.status, 0, "Generate a disposable loopback-only TLS fixture");
const manifestRequests = [];
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
  manifestRequests.push(request.url);
  if (request.url === "/updates/device/stable.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1, version: runtimeVersion, url: "/unchanged-cli.cjs",
      sha256: expectedSha256, minNodeVersion: "22.5.0"
    }));
  } else {
    response.writeHead(404);
    response.end();
  }
});
const peer = new WebSocketServer({ server });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = "https://127.0.0.1:" + address.port;
const config = join(temporary, "device config 配置.json");
writeFileSync(config, JSON.stringify({
  url, deviceId: "npm-hotfix-fixture", slug: "npm-hotfix-fixture",
  token: "synthetic-loopback-test-token", name: "npm fixture"
}));
const configBefore = digest(readFileSync(config));
writeFileSync(join(root, "fixture.txt"), "read-during-writer-ok\n");
writeFileSync(join(temporary, "outside.txt"), "outside-root-must-remain-private\n");
const stateDir = join(dirname(config), "updates", digest(realpathSync(config)).slice(0, 16));
const statePath = join(stateDir, "state.json");
const cachedBundle = join(stateDir, "releases", expectedSha256, "cli.cjs");
const pending = new Map();
const hellos = [];
let socket;
let helloWaiter;
let callCounter = 0;
peer.on("connection", (connection, request) => {
  assert.equal(request.headers.authorization, "Bearer synthetic-loopback-test-token");
  socket = connection;
  connection.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "hello") {
      connection.send(JSON.stringify({
        type: "hello_ack", deviceId: "npm-hotfix-fixture", slug: "npm-hotfix-fixture", serverTime: Date.now()
      }));
      hellos.push(message);
      helloWaiter?.resolve(message);
    } else if (message.type === "result") {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
});
function state() {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; }
}
async function wait(predicate, label, timeout = 10000) {
  const until = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < until, label);
    await delay(20);
  }
}
async function deadline(promise, timeout, reason) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason())), timeout); })
    ]);
  } finally { clearTimeout(timer); }
}
function call(tool, args, timeoutMs = 2000) {
  const id = String(++callCounter);
  const result = Promise.withResolvers();
  pending.set(id, result);
  socket.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs }));
  return { id, result: deadline(result.promise, timeoutMs + 3000, () => "Loopback tool result timed out: " + tool) };
}
function tree(pid) {
  const result = [];
  function visit(current) {
    try {
      const args = readFileSync("/proc/" + current + "/cmdline", "utf8").split("\0").filter(Boolean);
      result.push({ pid: current, args });
      const children = readFileSync("/proc/" + current + "/task/" + current + "/children", "utf8").trim();
      if (children) for (const child of children.split(/\s+/)) visit(Number(child));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  visit(pid);
  return result;
}
let active;
const trees = [];
const stateSnapshots = [];
async function start(preserveSymlinksMain) {
  helloWaiter = Promise.withResolvers();
  const nodeOptions = preserveSymlinksMain ? ["--preserve-symlinks-main"] : [];
  const child = spawn(process.execPath, [
    ...nodeOptions, bin, "connect", "--config", config, "--root", root,
    "--packs", "minimal,omp", "--name=--npm 名称", "--update-manifest", url + "/updates/device/stable.json",
    "--update-interval", "10"
  ], {
    env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: tmpdir(), NODE_EXTRA_CA_CERTS: cert },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (value) => { logs = (logs + value).slice(-16000); });
  child.stderr.on("data", (value) => { logs = (logs + value).slice(-16000); });
  const exit = once(child, "exit");
  active = { child, exit, logs: () => logs };
  const announced = await deadline(Promise.race([
    helloWaiter.promise,
    exit.then(() => { throw new Error("Client exited before authentication: " + logs); })
  ]), 12000, () => "Client authentication timed out: " + logs);
  assert.equal(announced.device.version, runtimeVersion);
  assert.equal(announced.device.name, "--npm 名称");
  assert.ok(announced.tools.some((tool) => tool.name === "read"));
  assert.ok(announced.tools.some((tool) => tool.name === "bash"));
  assert.ok(!announced.tools.some((tool) => tool.name === "kernel_eval"));
  await wait(() => state()?.phase === "running" && state()?.lastResult?.status === "current",
    "Managed supervisor must finish its real local HTTPS manifest check");
  const current = state();
  assert.equal(current.current.sha256, expectedSha256);
  assert.equal(current.current.version, runtimeVersion);
  assert.equal(digest(readFileSync(cachedBundle)), expectedSha256);
  assert.equal(current.current.entryPoint, cachedBundle);
  const processes = tree(child.pid);
  assert.equal(processes.length, 3, "Exactly one launcher, supervisor and worker");
  assert.equal(processes.filter((item) => item.args.includes(cachedBundle)).length, 2);
  assert.ok(processes.every((item) => !item.args.some((arg) => arg.includes("synthetic-loopback-test-token"))));
  trees.push({ preserveSymlinksMain, processes });
  stateSnapshots.push({ preserveSymlinksMain, sha256: current.current.sha256, version: current.current.version, phase: current.phase });
  return active;
}
async function stop() {
  if (!active) return;
  const running = active;
  active = undefined;
  running.child.kill("SIGTERM");
  const result = await deadline(running.exit, 10000, () => {
    running.child.kill("SIGKILL");
    return "Managed launcher failed to stop: " + running.logs();
  });
  assert.deepEqual(result, [0, null]);
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const watchdog = setTimeout(() => { if (active) active.child.kill("SIGKILL"); }, 45000);
try {
  await start(false);
  const ready = join(root, "writer-ready");
  const slow = call("bash", {
    command: "printf ready > " + quote(ready) + "; sleep 1; printf slow-done", timeout_ms: 5000
  }, 6000);
  await wait(() => existsSync(ready), "Writer must acquire its slot");
  const expired = call("write", { path: "expired.txt", content: "must-never-write" }, 50);
  const read = await call("read", { path: "fixture.txt" }).result;
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read.result), /read-during-writer-ok/);
  assert.equal((await expired.result).error?.code, "tool_timeout");
  assert.equal((await slow.result).ok, true);
  assert.equal(existsSync(join(root, "expired.txt")), false);

  const cancelReady = join(root, "cancel-ready");
  const trigger = join(root, "trigger");
  const late = join(root, "late.txt");
  const cancelled = call("bash", {
    command: "(while [ ! -f " + quote(trigger) + " ]; do sleep 0.01; done; printf late > " + quote(late) +
      ") & printf ready > " + quote(cancelReady) + "; wait", timeout_ms: 10000
  }, 11000);
  await wait(() => existsSync(cancelReady), "Cancellable child must start");
  socket.send(JSON.stringify({ type: "cancel", id: cancelled.id }));
  assert.equal((await cancelled.result).error?.code, "tool_cancelled");
  assert.equal((await call("write", { path: "after-cancel.txt", content: "slot-released" }).result).ok, true);
  writeFileSync(trigger, "go");
  await delay(100);
  assert.equal(existsSync(late), false);
  const outside = await call("read", { path: "../outside.txt" }).result;
  assert.equal(outside.ok, false);
  await stop();

  await start(true);
  assert.equal((await call("read", { path: "after-cancel.txt" }).result).ok, true);
  await stop();
  assert.equal(digest(readFileSync(config)), configBefore);
  assert.equal(digest(readFileSync(bundle)), expectedSha256);
  assert.ok(manifestRequests.length >= 2);
  assert.ok(manifestRequests.every((path) => path === "/updates/device/stable.json"));
  for (const snapshot of trees) for (const item of snapshot.processes) {
    assert.throws(() => process.kill(item.pid, 0), { code: "ESRCH" });
  }
  console.log(JSON.stringify({
    passed: true, runtimeVersion, runtimeSha256: expectedSha256, sourceRuntimeUnchanged: true,
    authenticatedStarts: hellos.length, supervisorWorkerProcessCount: 3, stateSnapshots,
    configSha256Before: configBefore, configSha256After: digest(readFileSync(config)),
    tlsLoopbackOnly: true, realManifestChecks: manifestRequests.length,
    originalRuntimeCached: true, existingStateRestarted: true, signalsPreserved: true,
    writerDeadlinePreserved: true, concurrentReadPreserved: true, cancelledChildAbsent: true,
    writerSlotContinues: true, rootBoundaryPreserved: true, kernelEnabled: false,
    allManagedProcessesExited: true
  }));
} catch (error) {
  if (active) console.error(active.logs());
  throw error;
} finally {
  clearTimeout(watchdog);
  if (active) {
    active.child.kill("SIGTERM");
    try { await deadline(active.exit, 10000, () => "Final fixture shutdown timed out"); } catch { /* kill below */ }
    if (active.child.exitCode === null) active.child.kill("SIGKILL");
  }
  for (const connection of peer.clients) connection.terminate();
  await new Promise((done) => peer.close(done));
  await new Promise((done) => server.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
