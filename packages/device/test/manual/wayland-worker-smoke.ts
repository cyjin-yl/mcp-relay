/** Exercise the actual standalone CLI and computer pack on the private native desktop. */
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { pngDimensions } from "../../src/computer/native.js";
import type { ComputerAction, ComputerDisplay, ComputerState } from "../../src/computer/types.js";

type Result = { isError?: boolean; structuredContent?: Record<string, any>;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
type Wire = { type?: string; id?: string; ok?: boolean; result?: Result; error?: unknown;
  device?: { platform?: string; version?: string }; tools?: Array<{ name: string }> };
type Frame = { frame_id: string; display: ComputerDisplay };

async function main(): Promise<void> {
  assert.equal(process.env.RELAY_WAYLAND_NATIVE_TEST, "headless-mutter-private-bus");
  assert.equal(process.env.DISPLAY, undefined);
  const evidence = process.env.RELAY_NATIVE_EVIDENCE_DIR!;
  assert.ok(evidence?.startsWith("/"));
  const bundle = resolve(process.argv[2] ?? "packages/device/dist/cli.cjs");
  const fixtureScript = resolve("packages/device/test/manual/wayland-portal-smoke.py");
  const root = join(evidence, "worker-workspace");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const config = join(root, "device.json");
  const checks: string[] = [];
  let observed: Record<string, any> = {}, diagnostic = "", workerLog = "";
  let fixture: ChildProcessWithoutNullStreams | undefined, worker: ChildProcess | undefined, socket: WebSocket | undefined;
  const hellos: Wire[] = [];
  const pending = new Map<string, { resolve(value: Wire): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const env = { ...process.env, GDK_BACKEND: "wayland", MCP_RELAY_WORKER: "1", MCP_RELAY_SUPERVISOR: "0",
    MCP_RELAY_LAUNCHED: "0", MCP_RELAY_START_DRAINED: "0" };
  const report: Record<string, any> = { passed: false, checks,
    bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
    harnessSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"),
    sourceRevision: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    scale: Number(process.env.RELAY_TEST_SCALE), transport: process.env.RELAY_TEST_INPUT_TRANSPORT,
    startedAt: new Date().toISOString() };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done, reject) => { server.once("listening", done); server.once("error", reject); });
  const address = server.address(); assert(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  writeFileSync(config, JSON.stringify({ url, token: "synthetic-wayland-worker", deviceId: "dev_wayland_worker",
    name: "Private Wayland fixture", slug: "wayland-worker-fixture" }), { mode: 0o600 });

  async function until(test: () => boolean, label: string, timeout = 10000) {
    const end = Date.now() + timeout;
    while (!test() && Date.now() < end) await delay(30);
    assert.ok(test(), label + "; observed=" + JSON.stringify(observed) + "; fixture=" + diagnostic + "; worker=" + workerLog);
  }
  function passed(label: string) { checks.push(label); process.stdout.write("Worker check passed: " + label + "\n"); }
  function data(result: Result): Record<string, any> {
    return result.structuredContent ?? JSON.parse(result.content?.find(part => part.type === "text")?.text ?? "{}");
  }
  function success(result: Result): Record<string, any> {
    assert.notEqual(result.isError, true, JSON.stringify(data(result))); return data(result);
  }
  server.on("connection", (wire, request) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-wayland-worker");
    socket = wire;
    wire.on("message", bytes => {
      const message = JSON.parse(bytes.toString()) as Wire;
      if (message.type === "hello") {
        wire.send(JSON.stringify({ type: "hello_ack", deviceId: "dev_wayland_worker", slug: "wayland-worker-fixture", serverTime: Date.now() }));
        hellos.push(message);
      } else if (message.type === "result" && message.id) {
        const waiter = pending.get(message.id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
      }
    });
  });
  async function call(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
    assert(socket && socket.readyState === 1);
    const id = randomUUID();
    const reply = await new Promise<Wire>((resolveCall, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CLI call timed out: " + tool)); }, 45000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      socket!.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs: 40000 }));
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.error)); assert(reply.result); return reply.result;
  }
  async function command(executable: string, args: string[], input?: Buffer) {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout = (stdout + String(bytes)).slice(-64000); });
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-16000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject); child.once("exit", done); child.stdin.end(input);
    }).finally(() => clearTimeout(timer));
    return { code, stdout, stderr };
  }
  async function python(mode: string, args: string[] = [], input?: Buffer) {
    const result = await command("/usr/bin/python3", ["-u", fixtureScript, mode, ...args], input);
    assert.equal(result.code, 0, JSON.stringify(result)); return JSON.parse(result.stdout.trim()) as Record<string, any>;
  }
  async function local(commandName: string) {
    const result = await command(process.execPath, [bundle, commandName, "--config", config]);
    assert.equal(result.code, 0, JSON.stringify(result)); return JSON.parse(result.stdout.trim()) as Record<string, any>;
  }
  async function info() { return success(await call("computer_info")) as ComputerState & { enabled: boolean; paused: boolean }; }
  async function authorize() {
    const setup = call("computer_setup", { timeout_ms: 30000 });
    void setup.catch(() => undefined);
    assert.equal((await python("allow")).dialogAction, "Share");
    success(await setup);
    const state = await info();
    assert.equal(state.available, true, JSON.stringify(state));
    assert.equal(state.details?.inputTransport, report.transport);
    fixture!.stdin.write(JSON.stringify({ operation: "present" }) + "\n");
    await delay(300);
    return state;
  }
  async function frame(name?: string): Promise<Frame> {
    const result = await call("computer_screenshot"), value = success(result) as Frame;
    const image = result.content?.find(part => part.type === "image");
    assert(image?.data); assert.equal(image.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64");
    assert.deepEqual(pngDimensions(png), { width: value.display.width, height: value.display.height });
    assert.equal(value.display.width, observed.logicalWidth * observed.gdkScale);
    assert.equal(value.display.height, observed.logicalHeight * observed.gdkScale);
    const sample = [60, 150].map(n => n * observed.gdkScale);
    const pixels = await python("png", [JSON.stringify([sample])], png);
    const expected = observed.clicks ? [29, 181, 83] : [211, 51, 63];
    assert(expected.every((v, channel) => Math.abs(pixels.samples[0][channel] - v) <= 3), "Pack image must contain actual fixture pixels");
    if (name) writeFileSync(join(evidence, "worker-" + name + ".png"), png, { mode: 0o600 });
    return value;
  }
  const point = (x: number, y: number) => ({ x: x * observed.gdkScale, y: y * observed.gdkScale });
  async function act(action: ComputerAction) {
    const shot = await frame();
    return success(await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
      action, screenshot_after: false, timeout_ms: 15000 }));
  }
  function helpers(): number[] {
    assert(worker?.pid);
    const pids = readFileSync(`/proc/${worker.pid}/task/${worker.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    return pids.map(Number).filter(pid => {
      try { const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return argv.includes("-I") && argv.includes("-c") && argv.some(arg => arg.includes("org.freedesktop.portal.Desktop"));
      } catch { return false; }
    });
  }

  try {
    fixture = spawn("/usr/bin/python3", ["-u", fixtureScript, "fixture"], { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    createInterface({ input: fixture.stdout }).on("line", line => { observed = JSON.parse(line); });
    fixture.stderr.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-16000); });
    await until(() => /Wayland/.test(observed.displayType ?? "") && observed.logicalWidth >= 640, "Native fixture readiness");
    assert.equal((await local("computer-enable")).enabled, true);
    const oneShot = await command(process.execPath, [bundle, "computer-setup", "--config", config]);
    assert.notEqual(oneShot.code, 0);
    assert.match(oneShot.stderr, /connected worker|computer_setup/i);
    assert.equal((await python("absent")).dialogAbsent, true);
    passed("standalone setup refuses a non-transferable grant without opening consent");

    worker = fork(bundle, ["connect", "--root", root, "--config", config, "--url", url,
      "--packs", "computer", "--allow-computer", "--no-auto-update"], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env
    });
    worker.stdout!.on("data", bytes => { workerLog = (workerLog + String(bytes)).slice(-64000); });
    worker.stderr!.on("data", bytes => { workerLog = (workerLog + String(bytes)).slice(-64000); });
    await until(() => hellos.length === 1, "Standalone worker registration", 20000);
    const hello = hellos[0]!;
    const version = JSON.parse(readFileSync(resolve("packages/device/package.json"), "utf8")).version;
    assert.equal(hello.device?.version, version); report.deviceVersion = version;
    for (const name of ["computer_info", "computer_setup", "computer_screenshot", "computer_action", "computer_handoff"]) {
      assert(hello.tools?.some(tool => tool.name === name));
    }
    const before = await info();
    assert.equal(before.backend, "linux-wayland-portal"); assert.equal(before.enabled, true); assert.equal(before.available, false);
    assert.equal((await python("absent")).dialogAbsent, true);
    passed("actual packaged CLI registers Wayland and inspects without requesting permission");

    const state = await authorize(), original = await frame("first-frame");
    assert.equal(helpers().length, 1, "The grant belongs to the connected CLI worker");
    const request = { request_id: randomUUID(), frame_id: original.frame_id,
      action: { type: "click", ...point(100, 100) }, screenshot_after: false, timeout_ms: 15000 };
    const submitted = success(await call("computer_action", request));
    assert.equal(submitted.submitted, true); assert.equal(submitted.verified, false);
    await until(() => observed.clicks === 1, "Actual native button click through CLI pack");
    success(await call("computer_action", request));
    const stale = await call("computer_action", { ...request, request_id: randomUUID() });
    assert.equal(stale.isError, true); assert.equal(data(stale).code, "stale_frame");
    await delay(100); assert.equal(observed.clicks, 1);
    await frame("after-click");
    passed("CLI input changes native pixels; duplicate requests and consumed frames do not replay it");

    if (report.transport === "eis") {
      assert(state.actions.includes("text"));
      await act({ type: "click", ...point(100, 40) });
      await act({ type: "text", text: "Pack 42 !@#:/[]{}?" });
      await until(() => observed.text === "Pack 42 !@#:/[]{}?", "Packaged helper enters actual mixed-case text");
      passed("packaged EIS helper types uppercase and punctuation into the native application");
    } else {
      assert(!state.actions.includes("key") && !state.actions.includes("text"));
      const shot = await frame();
      const refused = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "text", text: "Must Not Type!" } });
      assert.equal(refused.isError, true); assert.equal(data(refused).code, "unsupported_action");
      assert.equal(observed.text, "");
      passed("legacy keyboard capability is refused by the actual computer pack without input");
    }

    success(await call("computer_handoff", { mode: "pause" }));
    const paused = await info(); assert.equal(paused.paused, true); assert.equal(paused.available, false);
    assert.equal((await call("computer_screenshot")).isError, true);
    success(await call("computer_handoff", { mode: "resume" }));
    assert.equal((await info()).available, false);
    assert.equal((await python("absent")).dialogAbsent, true);
    await authorize(); const resumed = await frame();
    assert.notEqual(resumed.display.instanceId, original.display.instanceId);
    passed("handoff closes the real grant and resume requires fresh local consent");

    assert.equal(helpers().length, 1);
    assert.equal((await local("computer-pause")).paused, true);
    await until(() => helpers().length === 0, "Idle local pause closes the actual helper without another RPC", 5000);
    assert.equal((await local("computer-resume")).paused, false);
    assert.equal((await info()).available, false);
    await authorize(); await frame();
    passed("local CLI pause revokes an idle worker grant before another remote call");

    const registrations = hellos.length;
    socket!.close(1000, "owned native test disconnect");
    await until(() => hellos.length > registrations, "Owned worker reconnect", 15000);
    assert.equal((await info()).available, false);
    assert.equal((await python("absent")).dialogAbsent, true);
    assert.equal(observed.clicks, 1, "The user application survives connection loss");
    passed("WebSocket reconnect cannot reuse the old grant and preserves the native application");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Owned fixture cleanup")); }
    pending.clear();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      if (worker.connected) worker.disconnect();
      await new Promise<void>(done => {
        const timer = setTimeout(() => { worker?.kill("SIGKILL"); done(); }, 4000);
        worker!.once("exit", () => { clearTimeout(timer); done(); });
      });
    }
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.end(JSON.stringify({ operation: "quit" }) + "\n");
      await new Promise<void>(done => {
        const timer = setTimeout(() => { fixture?.kill("SIGKILL"); done(); }, 1000);
        fixture!.once("exit", () => { clearTimeout(timer); done(); });
      });
    }
    report.completedAt = new Date().toISOString(); report.observed = observed;
    writeFileSync(join(evidence, "worker-receipt.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(join(evidence, "worker.log"), workerLog + "\n" + diagnostic, { mode: 0o600 });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
