/**
 * Native PVE acceptance through the real standalone CLI and its WebSocket wire.
 * Only pve:990190, created by pve-fixture.py, receives screenshot/input requests.
 * Run: node pve-computer-smoke.cjs cli.cjs <owned-fixture-directory> <evidence>
 * Fixture creation and removal remain deliberate, separate host operations.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { pngDimensions } from "../../src/computer/native.js";
import type { ComputerAction, ComputerDisplay, ComputerState } from "../../src/computer/types.js";

const target = "pve:990190";
type Result = { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>; isError?: boolean };
type Wire = { type?: string; id?: string; ok?: boolean; result?: Result; error?: unknown;
  device?: { platform?: string; version?: string }; tools?: Array<{ name: string }> };
type Frame = { frame_id: string; display: ComputerDisplay & { instanceId?: string } };
type Fixture = { fixture: string; vmid: number; sequence: number; devices: number; observed_at: number;
  keyDown: number; keyUp: number; clicks: number; releases: number; x: number; y: number;
  wheelY: number; wheelX: number; lastKey: number; lastKeyDevice?: string; text: string };

function data(result: Result): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.find(item => item.type === "text")?.text ?? "{}");
}
async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timeout: " + label);
    await delay(40);
  }
}
async function main(): Promise<void> {
  assert.equal(process.platform, "linux", "Run on the PVE host");
  assert(process.argv[2] && process.argv[3] && process.argv[4], "Pass bundle, owned fixture and evidence paths");
  const bundle = resolve(process.argv[2]), fixtureDirectory = resolve(process.argv[3]), evidence = resolve(process.argv[4]);
  const marker = JSON.parse(readFileSync(join(fixtureDirectory, "owner.json"), "utf8"));
  assert.equal(marker.vmid, 990190); assert.equal(marker.name, "mcp-relay-cua-qa-019");
  assert.equal(marker.created_vm, true, "Only the currently owned fixture can be tested");
  const statePath = join(fixtureDirectory, "state.json");
  function state(): Fixture {
    const observed = JSON.parse(readFileSync(statePath, "utf8")) as Fixture;
    assert.equal(observed.fixture, marker.name); assert.equal(observed.vmid, marker.vmid);
    assert(Date.now() - observed.observed_at * 1000 < 5000, "The owned guest's serial observer is stale");
    return observed;
  }
  await until(() => { try { return state().devices >= 2; } catch { return false; } }, 30000, "owned guest input UI");
  assert.equal(state().text, "", "Use a freshly created fixture for an unambiguous text assertion");
  mkdirSync(evidence, { recursive: true });
  const workspace = join(evidence, "worker-workspace"); mkdirSync(workspace, { recursive: true });
  const cases: Array<{ name: string; passed: boolean; error?: string }> = [];
  const report: Record<string, unknown> = { target, cases, passed: false, startedAt: new Date().toISOString(),
    node: process.version, bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
    harnessSha256: createHash("sha256").update(readFileSync(resolve(process.argv[1]))).digest("hex") };
  const check = async (name: string, operation: () => Promise<void>) => {
    try { await operation(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error) }); throw error; }
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(done => server.once("listening", done));
  const address = server.address(); assert(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const config = join(workspace, "fixture-device.json");
  const syntheticToken = "synthetic-pve-smoke-" + randomUUID();
  writeFileSync(config, JSON.stringify({ url, token: syntheticToken, deviceId: "dev_pve_owned_smoke",
    name: "Owned PVE native smoke", slug: "pve-owned-smoke" }), { mode: 0o600 });
  let socket: WebSocket | undefined, worker: ChildProcess | undefined, workerLog = "";
  const registration = Promise.withResolvers<Wire>();
  const pending = new Map<string, { done(value: Wire): void; fail(error: Error): void; timer: NodeJS.Timeout }>();
  server.on("connection", (wire, request) => {
    if (request.headers.authorization !== "Bearer " + syntheticToken) {
      registration.reject(new Error("Synthetic worker authentication mismatch")); wire.terminate(); return;
    }
    socket = wire;
    wire.on("message", bytes => {
      const message = JSON.parse(bytes.toString()) as Wire;
      if (message.type === "hello") {
        wire.send(JSON.stringify({ type: "hello_ack", deviceId: "dev_pve_owned_smoke", slug: "pve-owned-smoke", serverTime: Date.now() }));
        registration.resolve(message);
      } else if (message.type === "result" && message.id) {
        const waiting = pending.get(message.id);
        if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); waiting.done(message); }
      }
    });
  });
  function begin(tool: string, args: Record<string, unknown>) {
    const id = randomUUID();
    const promise = new Promise<Wire>((done, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error("No worker response for " + tool)); }, 45000);
      pending.set(id, { done, fail, timer });
      socket!.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs: 40000 }));
    });
    void promise.catch(() => undefined);
    return { id, promise };
  }
  async function call(tool: string, args: Record<string, unknown>): Promise<Result> {
    const response = await begin(tool, args).promise;
    assert.equal(response.ok, true, JSON.stringify(response.error)); assert(response.result);
    return response.result;
  }
  async function frame(filename?: string, tolerateBusy = false): Promise<Frame> {
    const deadline = Date.now() + 10000;
    let result: Result;
    for (;;) {
      state();
      result = await call("computer_screenshot", { display_id: target, timeout_ms: 15000 });
      if (!tolerateBusy || data(result).code !== "computer_busy") break;
      assert(Date.now() < deadline, "Cancelled PVE input did not release the lane"); await delay(100);
    }
    assert.notEqual(result.isError, true, JSON.stringify(data(result)));
    const observed = data(result) as unknown as Frame;
    assert.equal(observed.display.id, target); assert(observed.frame_id); assert(observed.display.instanceId);
    const image = result.content?.find(item => item.type === "image"); assert(image?.data);
    assert.equal(image.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64"), dimensions = pngDimensions(png);
    assert.equal(observed.display.width, dimensions.width); assert.equal(observed.display.height, dimensions.height);
    if (filename) writeFileSync(join(evidence, filename), png);
    return observed;
  }
  async function act(action: ComputerAction | ((display: ComputerDisplay) => ComputerAction), tolerateBusy = false): Promise<void> {
    const shot = await frame(undefined, tolerateBusy);
    const inputAction = typeof action === "function" ? action(shot.display) : action;
    const result = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
      action: inputAction, timeout_ms: inputAction.type === "text" ? 30000 : 15000 });
    assert.notEqual(result.isError, true, JSON.stringify(data(result)));
  }
  function pointerMatches(display: ComputerDisplay, x: number, y: number): boolean {
    const current = state();
    return Math.abs(current.x / 32767 - x / (display.width - 1)) <= 2 / display.width
      && Math.abs(current.y / 32767 - y / (display.height - 1)) <= 2 / display.height;
  }
  try {
    worker = fork(bundle, ["connect", "--root", workspace, "--config", config, "--url", url,
      "--packs", "minimal,computer", "--allow-computer", "--no-auto-update"], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        MCP_RELAY_WORKER: "1", MCP_RELAY_SUPERVISOR: "0", MCP_RELAY_LAUNCHED: "0", MCP_RELAY_START_DRAINED: "0" }
    });
    for (const output of [worker.stdout, worker.stderr]) output!.on("data", bytes => {
      workerLog = (workerLog + bytes.toString()).slice(-16000);
    });
    worker.once("error", error => registration.reject(error));
    const timer = setTimeout(() => registration.reject(new Error("Worker did not register")), 20000);
    let hello: Wire; try { hello = await registration.promise; } finally { clearTimeout(timer); }
    report.deviceVersion = hello.device?.version;
    await check("real standalone CLI advertises target-aware PVE computer tools", async () => {
      for (const name of ["computer_info", "computer_screenshot", "computer_action"]) assert(hello.tools?.some(item => item.name === name));
      const result = await call("computer_info", { display_id: target, timeout_ms: 15000 });
      assert.notEqual(result.isError, true, JSON.stringify(data(result)));
      const capabilities = data(result) as unknown as ComputerState;
      assert.equal(capabilities.available, true); assert.equal(capabilities.unicodeText, false);
      assert(capabilities.displays.some(item => item.id === target));
      for (const action of ["move", "click", "drag", "scroll", "key", "text"]) assert(capabilities.actions.includes(action as ComputerAction["type"]));
      report.capabilities = capabilities;
    });
    await check("actual guest PNG carries dimensions and a bound VM process identity", async () => {
      report.display = (await frame("pve-first-frame.png")).display;
    });
    await check("screenshot pixel movement arrives as USB tablet coordinates", async () => {
      let display!: ComputerDisplay, x = 0, y = 0;
      await act(value => { display = value; x = Math.floor(value.width / 3); y = Math.floor(value.height / 3); return { type: "move", x, y }; });
      await until(() => pointerMatches(display, x, y), 5000, "guest tablet position");
      report.pointer = { x, y, guestX: state().x, guestY: state().y };
    });
    await check("real click arrives once and duplicate request IDs never replay input", async () => {
      const before = state(), shot = await frame();
      const args = { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "click", x: Math.floor(shot.display.width / 2), y: Math.floor(shot.display.height / 2) }, timeout_ms: 15000 };
      const first = await call("computer_action", args); assert.notEqual(first.isError, true, JSON.stringify(data(first)));
      await until(() => state().clicks === before.clicks + 1 && state().releases === before.releases + 1, 5000, "guest click and release");
      const after = state(), cached = await call("computer_action", args);
      assert.notEqual(cached.isError, true, JSON.stringify(data(cached)));
      await until(() => state().sequence > after.sequence, 2000, "next guest receipt after cached request");
      assert.equal(state().clicks, after.clicks); assert.equal(state().releases, after.releases);
      const stale = await call("computer_action", { ...args, request_id: randomUUID() });
      assert.equal(stale.isError, true); assert.equal(data(stale).code, "stale_frame");
    });
    const text = "Relay PVE 0.1.9!? " + "Az09-_=+[]()! ".repeat(12);
    await check("ASCII text with uppercase and punctuation reaches the guest without Enter", async () => {
      await act({ type: "text", text });
      await until(() => state().text === text && state().keyDown === state().keyUp, 5000, "guest typed text and released keys");
      assert.notEqual(state().lastKey, 28, "Text must not append Enter");
      report.keyboardSource = state().lastKeyDevice;
      if (process.env.MCP_RELAY_SMOKE_EXPECT_USB_KEYBOARD === "1") {
        assert.match(state().lastKeyDevice ?? "", /USB.*Keyboard|Keyboard.*USB/i,
          "The guest must prove the text arrived on its USB keyboard, not a fallback PS/2 keyboard");
      }
    });
    await check("key chords and Backspace reach the guest keyboard", async () => {
      await act({ type: "key", keys: ["Backspace"] });
      await until(() => state().text === text.slice(0, -1), 5000, "Backspace");
      await act({ type: "key", keys: ["Shift", "b"] });
      await until(() => state().text === text.slice(0, -1) + "B" && state().keyDown === state().keyUp, 5000, "shift chord");
    });
    await check("scroll down and up produce real guest wheel events", async () => {
      const before = state().wheelY;
      await act({ type: "scroll", direction: "down", amount: 3 });
      await until(() => state().wheelY === before - 3, 5000, "three downward wheel events");
      await act({ type: "scroll", direction: "up", amount: 2 });
      await until(() => state().wheelY === before - 1, 5000, "two upward wheel events");
    });
    await check("drag produces a held button, final movement and release", async () => {
      const before = state(); let display!: ComputerDisplay, x = 0, y = 0;
      await act(value => { display = value; x = Math.floor(value.width * 0.7); y = Math.floor(value.height * 0.7);
        return { type: "drag", fromX: 20, fromY: 20, toX: x, toY: y, durationMs: 500 }; });
      await until(() => state().clicks === before.clicks + 1 && state().releases === before.releases + 1
        && pointerMatches(display, x, y), 5000, "drag final guest state");
    });
    await check("cancellation releases the guest button and permits fresh input", async () => {
      const shot = await frame(), before = state();
      const operation = begin("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "drag", fromX: 20, fromY: 20, toX: Math.floor(shot.display.width * 0.8),
          toY: Math.floor(shot.display.height * 0.8), durationMs: 4000 }, timeout_ms: 15000 });
      await until(() => state().clicks > before.clicks && state().clicks > state().releases, 5000, "guest entered held-button state");
      socket!.send(JSON.stringify({ type: "cancel", id: operation.id }));
      const response = await operation.promise;
      assert(response.ok === false || response.result?.isError === true, "Cancelled input must not claim completed success");
      await until(() => state().clicks === state().releases, 8000, "guest button release on cancellation");
      await act({ type: "key", keys: ["ArrowLeft"] }, true);
      await until(() => state().lastKey === 105 && state().keyDown === state().keyUp, 5000, "next guest input after cancellation");
    });
    await check("out-of-frame coordinates, horizontal scrolling and Unicode fail before guest input", async () => {
      let shot = await frame(); const before = state();
      const invalid = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "click", x: shot.display.width, y: 0 } });
      assert.equal(invalid.isError, true); assert.equal(data(invalid).code, "coordinate_out_of_bounds");
      for (const direction of ["left", "right"]) {
        shot = await frame();
        const horizontal = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
          action: { type: "scroll", direction, amount: 3, x: 10, y: 10 } });
        assert.equal(horizontal.isError, true); assert.equal(data(horizontal).code, "unsupported_action");
      }
      shot = await frame();
      const unicode = await call("computer_action", { request_id: randomUUID(), frame_id: shot.frame_id,
        action: { type: "text", text: "中文" } });
      assert.equal(unicode.isError, true);
      await until(() => state().sequence > before.sequence, 2000, "guest receipt after refused input");
      assert.equal(state().clicks, before.clicks); assert.equal(state().keyDown, before.keyDown); assert.equal(state().text, before.text);
      assert.equal(state().x, before.x); assert.equal(state().y, before.y);
      assert.equal(state().wheelX, before.wheelX); assert.equal(state().wheelY, before.wheelY);
      report.unsupportedUnicode = data(unicode);
    });
    await frame("pve-final-frame.png");
    report.finalFixture = state(); report.passed = true; report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = String(error); process.exitCode = 1;
  } finally {
    for (const id of pending.keys()) { try { socket?.send(JSON.stringify({ type: "cancel", id })); } catch { /* disconnected */ } }
    if (worker?.connected) worker.disconnect();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      try { await until(() => worker!.exitCode !== null || worker!.signalCode !== null, 20000, "owned smoke worker exit"); }
      catch { worker.kill("SIGTERM"); report.workerCleanupPending = true; }
    }
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.fail(new Error("Harness closed")); }
    pending.clear(); for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    report.workerLog = workerLog.replaceAll(syntheticToken, "[synthetic-token]");
    report.completedAt = new Date().toISOString();
    writeFileSync(join(evidence, "pve-acceptance.json"), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
