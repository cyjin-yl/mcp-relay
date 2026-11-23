/**
 * CT102 builds this harness. Native CI runs only the resulting CJS and the
 * frozen standalone CLI. All input is directed to this invocation's own window.
 * Exit 77 means a verified OS/session/permission blocker, never a desktop pass.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { pngDimensions } from "../../src/computer/native.js";
import type { ComputerAction, ComputerDisplay, ComputerState } from "../../src/computer/types.js";
import { startNativeFixture, type FixtureState } from "./computer-native-fixtures.js";

type Result = { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>; isError?: boolean };
type Wire = { type?: string; id?: string; ok?: boolean; result?: Result; error?: unknown;
  device?: { platform?: string; version?: string }; tools?: Array<{ name: string }> };
type Frame = { frame_id: string; display: ComputerDisplay };
async function until(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timeout: " + label); await delay(60); }
}
function data(result: Result): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const part = result.content?.find(item => item.type === "text" && item.text);
  return JSON.parse(part?.text ?? "{}") as Record<string, unknown>;
}
async function main(): Promise<void> {
  assert(["win32", "darwin"].includes(process.platform), "Run this prebuilt harness on Windows or macOS.");
  const bundle = resolve(process.argv[2] ?? "");
  const evidence = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), "relay-computer-native-"));
  mkdirSync(evidence, { recursive: true });
  const root = join(evidence, "fixture workspace 中文"); mkdirSync(root, { recursive: true });
  const cases: Array<{ name: string; passed: boolean; error?: string }> = [];
  const check = async (name: string, work: () => Promise<void>) => {
    try { await work(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error) }); throw error; }
  };
  const report: Record<string, unknown> = { platform: process.platform, node: process.version, evidence, cases,
    bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"), startedAt: new Date().toISOString(), passed: false };
  let worker: ChildProcess | undefined, socket: WebSocket | undefined, fixture: ReturnType<typeof startNativeFixture> | undefined;
  let log = "";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(done => server.once("listening", done));
  const address = server.address(); assert(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const config = join(root, "device.json");
  writeFileSync(config, JSON.stringify({ url, token: "synthetic-computer-smoke", deviceId: "dev_computer_smoke",
    name: "Computer native fixture", slug: "computer-native-fixture" }));
  const registration = Promise.withResolvers<Wire>();
  const pending = new Map<string, { done(value: Wire): void; fail(error: Error): void; timer: NodeJS.Timeout }>();
  server.on("connection", (wire, request) => {
    if (request.headers.authorization !== "Bearer synthetic-computer-smoke") {
      registration.reject(new Error("Synthetic authentication mismatch")); wire.terminate(); return;
    }
    socket = wire;
    wire.on("message", bytes => {
      const message = JSON.parse(bytes.toString()) as Wire;
      if (message.type === "hello") {
        wire.send(JSON.stringify({ type: "hello_ack", deviceId: "dev_computer_smoke", slug: "computer-native-fixture", serverTime: Date.now() }));
        registration.resolve(message);
      } else if (message.type === "result" && message.id) {
        const waiter = pending.get(message.id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.done(message); }
      }
    });
  });
  function begin(tool: string, args: Record<string, unknown>) {
    const id = randomUUID();
    const promise = new Promise<Wire>((done, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error("No response for " + tool)); }, 45000);
      pending.set(id, { done, fail, timer }); socket!.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs: 40000 }));
    });
    void promise.catch(() => undefined);
    return { id, promise };
  }
  async function call(tool: string, args: Record<string, unknown>): Promise<Result> {
    const result = await begin(tool, args).promise;
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert(result.result); return result.result;
  }
  function fixtureState(): FixtureState | undefined {
    if (!fixture) return undefined;
    try { return JSON.parse(readFileSync(fixture.statePath, "utf8")) as FixtureState; } catch { return undefined; }
  }
  async function focused(): Promise<FixtureState> {
    await until(() => fixtureState()?.foreground === true, 10000, "owned fixture focus");
    const state = fixtureState()!; assert.equal(state.title, fixture!.title); return state;
  }
  let frameNumber = 0;
  async function frame(): Promise<Frame> {
    await focused();
    const result = await call("computer_screenshot", {});
    assert.notEqual(result.isError, true, JSON.stringify(data(result)));
    const metadata = data(result) as unknown as Frame;
    const image = result.content?.find(item => item.type === "image");
    assert(image?.data); assert.equal(image.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64"), size = pngDimensions(png);
    assert.equal(metadata.display.width, size.width); assert.equal(metadata.display.height, size.height);
    assert(metadata.frame_id);
    if (frameNumber++ === 0) writeFileSync(join(evidence, "native-first-frame.png"), png);
    return metadata;
  }
  function local(display: ComputerDisplay, native: { x: number; y: number }) {
    const point = { x: Math.round((native.x - display.x) * (display.scaleX ?? 1)),
      y: Math.round((native.y - display.y) * (display.scaleY ?? 1)) };
    assert(point.x >= 0 && point.y >= 0 && point.x < display.width && point.y < display.height,
      "Owned fixture must fit the selected primary display.");
    return point;
  }
  async function act(make: (display: ComputerDisplay, state: FixtureState) => ComputerAction): Promise<void> {
    const captured = await frame(), state = await focused();
    const result = await call("computer_action", { request_id: randomUUID(), frame_id: captured.frame_id,
      action: make(captured.display, state), screenshot_after: false, timeout_ms: 15000 });
    assert.notEqual(result.isError, true, JSON.stringify(data(result)));
  }
  try {
    worker = fork(bundle, ["connect", "--root", root, "--config", config, "--url", url,
      "--packs", "minimal,computer", "--allow-computer", "--no-auto-update"], {
      execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, MCP_RELAY_WORKER: "1", MCP_RELAY_SUPERVISOR: "0", MCP_RELAY_LAUNCHED: "0", MCP_RELAY_START_DRAINED: "0" }
    });
    worker.stdout!.on("data", chunk => { log = (log + chunk.toString()).slice(-64000); });
    worker.stderr!.on("data", chunk => { log = (log + chunk.toString()).slice(-64000); });
    worker.once("error", error => registration.reject(error));
    const timer = setTimeout(() => registration.reject(new Error("CLI did not register")), 20000);
    let hello: Wire; try { hello = await registration.promise; } finally { clearTimeout(timer); }
    report.deviceVersion = hello.device?.version;
    const infoResult = await call("computer_info", {});
    assert.notEqual(infoResult.isError, true, JSON.stringify(data(infoResult)));
    let info = data(infoResult) as unknown as ComputerState & { enabled: boolean };
    report.capabilities = info;
    await check("actual CLI registers the computer capability and native backend", async () => {
      assert.equal(hello.device?.platform, process.platform); assert.equal(info.platform, process.platform);
      assert.equal(info.enabled, true);
      for (const name of ["computer_info", "computer_screenshot", "computer_action"]) assert(hello.tools?.some(tool => tool.name === name));
      assert.equal(info.backend, process.platform === "win32" ? "windows-win32" : "macos-quartz");
    });
    let captureDenied = info.permissions.screenCapture === "denied" || (process.platform === "darwin" && info.available && info.permissions.screenCapture !== "granted");
    if (info.available && !captureDenied) {
      fixture = startNativeFixture(process.platform, evidence);
      fixture.child.once("error", error => { log += "\nfixture: " + String(error); });
      await focused();
      info = data(await call("computer_info", {})) as unknown as ComputerState & { enabled: boolean };
      report.capabilities = info;
      captureDenied = info.permissions.screenCapture === "denied" || (process.platform === "darwin" && info.available && info.permissions.screenCapture !== "granted");
    }
    if (!info.available || captureDenied || info.permissions.input === "denied" || info.actions.length === 0) {
      await check("OS/session permission blocker is explicit and never reported as UI success", async () => {
        assert(captureDenied || Object.values(info.permissions).some(value => value === "denied"),
          "An unexpected native helper failure is a test failure, not a permission skip.");
        if (!info.available || captureDenied) {
          const refused = await call("computer_screenshot", {});
          assert.equal(refused.isError, true, "A denied screenshot must fail without prompting for authorization.");
          assert(!refused.content?.some(item => item.type === "image"));
          report.blockedScreenshot = data(refused);
        } else if (fixture && info.permissions.input === "denied") {
          const shot = await frame(), state = await focused();
          const refused = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
            action: { type: "move", ...local(shot.display, state.regions.dragStart) }, screenshot_after: false });
          assert.equal(refused.isError, true, "Input denied by the OS must not be reported as submitted.");
          report.blockedAction = data(refused);
        }
      });
      report.status = "blocked"; report.passed = false; report.uiVerified = false; process.exitCode = 77;
      return;
    }
    assert(fixture, "Native test fixture must be ready before UI input.");
    await check("native PNG dimensions and screenshot pixel mapping", async () => {
      const shot = await frame(); local(shot.display, fixtureState()!.regions.text);
      report.display = shot.display;
    });
    await check("native pointer movement matches screenshot coordinates", async () => {
      const expected = fixtureState()!.regions.dragStart;
      await act((display, state) => ({ type: "move", ...local(display, state.regions.dragStart) }));
      await until(() => { const p = fixtureState()?.pointer; return !!p && Math.abs(p.x - expected.x) <= 2 && Math.abs(p.y - expected.y) <= 2; }, 5000, "pointer coordinates");
    });
    await check("click focus and Unicode text arrive in the owned native text control", async () => {
      await act((display, state) => ({ type: "click", ...local(display, state.regions.text) }));
      await act(() => ({ type: "text", text: "relay 中文🙂" }));
      await until(() => fixtureState()?.text === "relay 中文🙂", 6000, "Unicode text in fixture");
    });
    await check("native shortcut and replacement text", async () => {
      await act(() => ({ type: "key", keys: [process.platform === "darwin" ? "Meta" : "Ctrl", "a"] }));
      await act(() => ({ type: "text", text: "replaced ✓" }));
      await until(() => fixtureState()?.text === "replaced ✓", 6000, "shortcut selection and replacement");
    });
    await check("native button click", async () => {
      const before = fixtureState()!.clickCount;
      await act((display, state) => ({ type: "click", ...local(display, state.regions.click) }));
      await until(() => fixtureState()!.clickCount > before, 5000, "button event");
    });
    await check("native drag delivers down, dragged movement and release", async () => {
      const before = fixtureState()!.dragCount;
      await act((display, state) => {
        const from = local(display, state.regions.dragStart), to = local(display, state.regions.dragEnd);
        return { type: "drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: 400 };
      });
      await until(() => fixtureState()!.dragCount > before, 5000, "drag event");
    });
    await check("native wheel reaches the owned scroll region", async () => {
      const before = fixtureState()!.scrollCount;
      await act((display, state) => ({ type: "scroll", direction: "down", amount: 3, ...local(display, state.regions.scroll) }));
      await until(() => fixtureState()!.scrollCount > before, 5000, "scroll event");
    });
    await check("cancelled drag releases input before the next action", async () => {
      const shot = await frame(), state = await focused(), from = local(shot.display, state.regions.dragStart),
        to = local(shot.display, state.regions.dragEnd);
      const operation = begin("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: 4000 },
        screenshot_after: false, timeout_ms: 15000 });
      await until(() => (fixtureState() as FixtureState & { dragging?: boolean })?.dragging === true, 10000, "drag entered held state");
      socket!.send(JSON.stringify({ type: "cancel", id: operation.id }));
      const cancelled = await operation.promise;
      assert(cancelled.ok === false || cancelled.result?.isError === true);
      await until(() => (fixtureState() as FixtureState & { dragging?: boolean })?.dragging === false, 8000, "cancelled button release");
      const before = fixtureState()!.clickCount;
      await act((display, current) => ({ type: "click", ...local(display, current.regions.click) }));
      await until(() => fixtureState()!.clickCount > before, 5000, "next action after cancellation");
    });
    report.finalFixture = fixtureState();
    report.status = "passed"; report.passed = true; report.uiVerified = true;
  } catch (error) {
    report.status = "failed"; report.error = String(error); process.exitCode = 1;
  } finally {
    for (const id of pending.keys()) { try { socket?.send(JSON.stringify({ type: "cancel", id })); } catch { /* disconnected */ } }
    if (worker?.connected) worker.disconnect();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      try { await until(() => worker!.exitCode !== null || worker!.signalCode !== null, 25000, "owned worker cleanup"); }
      catch { report.workerCleanupPending = true; worker.kill("SIGTERM"); }
    }
    await fixture?.stop();
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.fail(new Error("Harness closed")); }
    pending.clear();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    report.workerLog = log; report.completedAt = new Date().toISOString();
    writeFileSync(join(evidence, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
