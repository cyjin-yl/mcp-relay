import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPveBackend, pveKeyChord, pveVmId } from "../src/computer/pve.js";
import { runNative } from "../src/computer/native.js";
import { type NativeCommand, type NativeContext } from "../src/computer/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOQsInCihgGUgIAg50goRxyB2kAAAAASUVORK5CYII=", "base64");
const context: NativeContext = { timeoutMs: 5000 };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
type Event = { type: string; data: Record<string, unknown> };

async function fixture(options: { pngSupported?: boolean; graphical?: boolean; absolute?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-pve-"));
  const script = join(root, "pvesh-fixture");
  const inventoryFile = join(root, "inventory.json");
  writeFileSync(inventoryFile, JSON.stringify([{ vmid: 101, name: "owned fixture", status: "running" }, { vmid: 102, name: "offline fixture", status: "stopped" }]));
  writeFileSync(script, "#!/usr/bin/python3\nimport pathlib,sys\nsys.stdout.write(pathlib.Path(" + JSON.stringify(inventoryFile) + ").read_text())\n");
  chmodSync(script, 0o755);
  writeFileSync(join(root, "101.pid"), String(process.pid) + "\n");
  const requests: Array<{ execute: string; arguments?: Record<string, unknown>; id: string }> = [];
  const input: Event[] = [];
  const runs: Array<{ operation: string; context: NativeContext }> = [];
  const sockets = new Set<Socket>();
  const state = { running: true, image: png, graphical: options.graphical ?? true, absolute: options.absolute ?? true, device: "vga", head: 0, namedDevice: true,
    onInput: undefined as undefined | ((events: Event[]) => void), blockNextInputReply: false };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ QMP: { version: { qemu: { major: 11, minor: 1, micro: 3 }, package: "fixture" }, capabilities: [] } }) + "\r\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as typeof requests[number];
        requests.push(request);
        const reply = (value: unknown) => socket.write(JSON.stringify({ return: value, id: request.id }) + "\r\n");
        const error = (description: string) => socket.write(JSON.stringify({ error: { class: "GenericError", desc: description }, id: request.id }) + "\r\n");
        switch (request.execute) {
          case "qmp_capabilities":
            // Responses must be matched by ID, not by the next received line.
            socket.write(JSON.stringify({ event: "RESET", data: {}, timestamp: { seconds: 1, microseconds: 0 } }) + "\r\n");
            socket.write(JSON.stringify({ return: {}, id: "unrelated-request" }) + "\r\n");
            reply({}); break;
          case "query-status": reply({ running: state.running, status: state.running ? "running" : "paused" }); break;
          case "qom-list": reply(state.graphical ? [{ name: "console[0]", type: "child<qemu-graphic-console>" }] : []); break;
          case "qom-get":
            if (request.arguments?.property === "id") { error("Property 'VGA.id' not found"); break; }
            reply(request.arguments?.property === "device" ? state.namedDevice ? "/machine/peripheral/" + state.device
              : "/machine/peripheral-anon/device[0]" : state.head); break;
          case "query-mice": reply([{ name: "fixture tablet", current: true, absolute: state.absolute, index: 1 }]); break;
          case "screendump": {
            if (request.arguments?.device !== state.device || request.arguments?.head !== state.head) { error("Device not found; expected qdev ID and selected head"); break; }
            const filename = request.arguments?.filename;
            if (typeof filename !== "string" || !filename.startsWith(root + "/mcp-relay-pve-")) throw new Error("capture path escaped private fixture root");
            if (options.pngSupported === false && request.arguments?.format) { error("Parameter 'format' is unexpected"); break; }
            writeFileSync(filename, options.pngSupported === false ? Buffer.concat([Buffer.from("P6\n# QEMU fixture\n8 6\n255\n"), Buffer.alloc(8 * 6 * 3, 80)]) : state.image);
            reply({}); break;
          }
          case "input-send-event": {
            if (request.arguments?.device !== state.device || request.arguments?.head !== state.head) { error("Device not found; expected qdev ID and selected head"); break; }
            const events = request.arguments?.events as Event[];
            input.push(...events);
            const block = state.blockNextInputReply;
            state.blockNextInputReply = false;
            state.onInput?.(events);
            if (!block) reply({});
            break;
          }
          default: error("Unknown fixture QMP command");
        }
      }
    });
  });
  const closeMonitor = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  cleanup.push(async () => {
    await closeMonitor();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(root, "101.qmp"), resolve); });
  const backend = createPveBackend({
    uid: () => 0,
    find: names => names[0] === "/usr/sbin/qm" ? "/usr/sbin/qm" : names[0] === "/usr/bin/pvesh" ? "/usr/bin/pvesh"
      : names.includes("/usr/bin/python3") ? "/usr/bin/python3" : undefined,
    run: async (spec: NativeCommand, ctx) => {
      const args = [...spec.args];
      const index = args.indexOf("-c") + 1;
      args[index] = args[index]!.replace('QMP_ROOT = "/run/qemu-server"', "QMP_ROOT = " + JSON.stringify(root))
        .replace('TEMP_ROOT = "/run"', "TEMP_ROOT = " + JSON.stringify(root))
        .replace('PVESH = "/usr/bin/pvesh"', "PVESH = " + JSON.stringify(script));
      const request = JSON.parse(String(spec.input)) as { operation: string };
      runs.push({ operation: request.operation, context: ctx });
      return runNative({ ...spec, args }, ctx);
    }
  });
  return { backend, root, inventoryFile, requests, input, runs, state, closeMonitor };
}

describe.runIf(process.platform === "linux")("PVE backend with real Python and Unix QMP sockets", () => {
  it("lists local running and stopped VMs, matches QMP IDs/events, and requires an explicit multi-VM target", async () => {
    const f = await fixture();
    const info = await f.backend.inspect(context);
    expect(info).toMatchObject({ backend: "pve-qmp", available: true, unicodeText: false, displays: [] });
    expect(info.details?.virtualMachines).toMatchObject([
      { vmid: 101, displayId: "pve:101", graphicalConsole: "available", inputAvailable: true, absolutePointer: true },
      { vmid: 102, status: "stopped", inputAvailable: false }
    ]);
    await expect(f.backend.screenshot(undefined, context)).rejects.toMatchObject({ code: "display_required" });
    expect(f.requests.every(request => request.execute !== "quit")).toBe(true);
    expect(f.input).toHaveLength(0);
  });

  it("captures actual PNG bytes with instance binding and cleans private capture files", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    expect(screen.data.equals(png)).toBe(true);
    expect(screen.display).toMatchObject({ id: "pve:101", width: 8, height: 6, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(screen.display.instanceId).toContain("pve:101:" + process.pid + ":");
    expect(screen.display.instanceId).toContain(":console:");
    expect(screen.app?.id).toBe(screen.display.instanceId);
    expect(readdirSync(f.root).some(name => name.startsWith("mcp-relay-pve-"))).toBe(false);
  });

  it("converts a legacy PPM screenshot to PNG without external imaging dependencies", async () => {
    const f = await fixture({ pngSupported: false });
    const screen = await f.backend.screenshot("pve:101", context);
    expect(screen.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    expect(screen.display).toMatchObject({ width: 8, height: 6 });
    expect(f.requests.filter(request => request.execute === "screendump").map(request => request.arguments?.format)).toEqual(["png", undefined]);
  });

  it("maps screenshot corners, syncs click edges separately, and pairs chord, wheel and printable ASCII keys", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    await f.backend.act({ type: "click", x: 7, y: 5, button: "right" }, screen.display, context);
    expect(f.input.slice(0, 4)).toEqual([
      { type: "abs", data: { axis: "x", value: 32767 } }, { type: "abs", data: { axis: "y", value: 32767 } },
      { type: "btn", data: { button: "right", down: true } }, { type: "btn", data: { button: "right", down: false } }
    ]);
    const clickBatches = f.requests.filter(request => request.execute === "input-send-event")
      .map(request => (request.arguments!.events as Event[]).filter(event => event.type === "btn" && event.data.button === "right"));
    expect(clickBatches.map(events => events.map(event => event.data.down))).toEqual([[true], [false], [false]]);
    await f.backend.act({ type: "key", keys: ["Control", "a"] }, screen.display, context);
    await f.backend.act({ type: "scroll", direction: "up", amount: 2 }, screen.display, context);
    await f.backend.act({ type: "text", text: 'Az! "~[]' }, screen.display, context);
    const held = new Set<string>();
    for (const event of f.input) {
      const name = event.type === "key" ? "key:" + (event.data.key as { data: string }).data : event.type === "btn" ? "btn:" + String(event.data.button) : undefined;
      if (name) { if (event.data.down) held.add(name); else held.delete(name); }
    }
    expect(held.size).toBe(0);
    expect(f.input.some(event => event.type === "key" && (event.data.key as { data: string }).data === "ret")).toBe(false);
    expect(f.input.filter(event => event.type === "btn" && event.data.button === "wheel-up")).toHaveLength(4);
  });

  it("rejects unsupported text and keys before sending any input", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    for (const text of ["中文", "line\nnext", "\t", "abc\0"]) {
      await expect(f.backend.act({ type: "text", text }, screen.display, context)).rejects.toMatchObject({ code: "unsupported_text" });
    }
    await expect(f.backend.act({ type: "key", keys: ["A; reboot"] }, screen.display, context)).rejects.toMatchObject({ code: "unsupported_key" });
    expect(f.input).toHaveLength(0);
  });

  it("reports paused and non-graphical VMs honestly and does not send paused input", async () => {
    const f = await fixture();
    f.state.running = false;
    const info = await f.backend.inspect(context, "pve:101");
    expect(info).toMatchObject({ available: false, actions: [], details: { status: "paused" } });
    const screen = await f.backend.screenshot("pve:101", context);
    await expect(f.backend.act({ type: "key", keys: ["Tab"] }, screen.display, context)).rejects.toMatchObject({ code: "vm_not_running" });
    f.state.graphical = false;
    await expect(f.backend.screenshot("pve:101", context)).rejects.toMatchObject({ code: "vm_no_graphical_console" });
    f.state.graphical = true;
    f.state.namedDevice = false;
    await expect(f.backend.screenshot("pve:101", context)).rejects.toMatchObject({ code: "vm_console_unaddressable" });
    expect(f.input).toHaveLength(0);
  });

  it("keeps keyboard input but refuses coordinate input when no absolute pointer is current", async () => {
    const f = await fixture({ absolute: false });
    const info = await f.backend.inspect(context, "pve:101");
    expect(info.actions).toEqual(["key", "text"]);
    const screen = await f.backend.screenshot("pve:101", context);
    await expect(f.backend.act({ type: "click", x: 1, y: 1 }, screen.display, context)).rejects.toMatchObject({ code: "absolute_pointer_unavailable" });
    expect(f.input).toHaveLength(0);
  });

  it("rejects VM process changes and resized displays at final dispatch without even sending cleanup input", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    writeFileSync(join(f.root, "101.pid"), String(process.ppid));
    await expect(f.backend.act({ type: "drag", fromX: 0, fromY: 0, toX: 7, toY: 5 }, screen.display, context)).rejects.toMatchObject({ code: "vm_changed" });
    writeFileSync(join(f.root, "101.pid"), String(process.pid));
    f.state.image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z3fkAAAAASUVORK5CYII=", "base64");
    await expect(f.backend.act({ type: "drag", fromX: 0, fromY: 0, toX: 7, toY: 5 }, screen.display, context)).rejects.toMatchObject({ code: "display_changed" });
    expect(f.input).toHaveLength(0);
    expect(f.runs.some(run => run.operation === "release")).toBe(false);
  });

  it("rejects a different graphical console in the same VM process even when its dimensions match", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    f.state.device = "replacement-vga";
    await expect(f.backend.act({ type: "drag", fromX: 0, fromY: 0, toX: 7, toY: 5 }, screen.display, context))
      .rejects.toMatchObject({ code: "console_changed", details: { mayHaveApplied: false } });
    const fresh = await f.backend.screenshot("pve:101", context);
    expect(fresh.display.instanceId).not.toBe(screen.display.instanceId);
    expect(fresh.display.width).toBe(screen.display.width);
    expect(f.input).toHaveLength(0);
    expect(f.runs.some(run => run.operation === "release")).toBe(false);
  });

  it("cancels an accepted drag and confirms button release through a fresh bounded helper before returning", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    const controller = new AbortController();
    f.state.blockNextInputReply = true;
    f.state.onInput = events => {
      if (events.some(event => event.type === "btn" && event.data.button === "left" && event.data.down === true)) controller.abort();
    };
    await expect(f.backend.act({ type: "drag", fromX: 0, fromY: 0, toX: 7, toY: 5, durationMs: 5000 }, screen.display,
      { timeoutMs: 6000, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    const buttons = f.input.filter(event => event.type === "btn" && event.data.button === "left");
    expect(buttons[0]?.data.down).toBe(true);
    expect(buttons.at(-1)?.data.down).toBe(false);
    expect(f.runs.at(-1)).toMatchObject({ operation: "release", context: { timeoutMs: 1500 } });
    expect(f.runs.at(-1)?.context.signal).toBeUndefined();
    expect(readdirSync(f.root).some(name => name.startsWith("mcp-relay-pve-"))).toBe(false);
  });

  it("cancels a click after button-down and releases that exact button through a fresh helper", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    const controller = new AbortController();
    f.state.blockNextInputReply = true;
    f.state.onInput = events => {
      if (events.some(event => event.type === "btn" && event.data.button === "right" && event.data.down === true)) controller.abort();
    };
    await expect(f.backend.act({ type: "click", x: 7, y: 5, button: "right" }, screen.display,
      { timeoutMs: 6000, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    const buttons = f.input.filter(event => event.type === "btn");
    expect(buttons[0]?.data).toMatchObject({ button: "right", down: true });
    expect(buttons.at(-1)?.data).toMatchObject({ button: "right", down: false });
    expect(buttons.every(event => event.data.button === "right")).toBe(true);
    expect(f.runs.at(-1)).toMatchObject({ operation: "release", context: { timeoutMs: 1500 } });
    expect(f.runs.at(-1)?.context.signal).toBeUndefined();
  });

  it("reports an unconfirmed drag release when its still-live VM monitor disappears", async () => {
    const f = await fixture();
    const screen = await f.backend.screenshot("pve:101", context);
    f.state.onInput = events => {
      if (events.some(event => event.type === "btn" && event.data.button === "left" && event.data.down === false)) void f.closeMonitor();
    };
    await expect(f.backend.act({ type: "drag", fromX: 0, fromY: 0, toX: 7, toY: 5, durationMs: 100 }, screen.display, context))
      .rejects.toMatchObject({ code: "input_cleanup_failed", details: { mayHaveApplied: true } });
    expect(f.runs.at(-1)?.operation).toBe("release");
  });
});

describe("PVE provider admission", () => {
  it("validates VM IDs and aliases without allowing command fragments", () => {
    expect(pveVmId("pve:101")).toBe(101);
    for (const value of ["pve:01", "pve:1", "pve:../101", "pve:101;reboot", "desktop"]) expect(() => pveVmId(value)).toThrow();
    expect(pveKeyChord(["Control", "Shift", "a"])).toEqual(["ctrl", "shift", "a"]);
    expect(() => pveKeyChord(["Control", "ctrl"])).toThrow();
  });

  it("uses absolute PVE executables and non-interactive sudo without opening a prompt", async () => {
    let native: NativeCommand | undefined;
    const backend = createPveBackend({ uid: () => 1000, find: names => names[0], run: async spec => {
      native = spec;
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("sudo: a password is required"), exitCode: 1 };
    } });
    const info = await backend.inspect(context);
    expect(native).toMatchObject({ command: "/usr/bin/sudo", args: ["-n", "--", "/usr/bin/python3", "-I", "-c", expect.any(String)] });
    expect(info).toMatchObject({ available: false, permissions: { qmp: "denied" }, details: { code: "pve_privilege_required" } });
  });

  it("does not claim QMP permission merely because PVE inventory was readable", async () => {
    const backend = createPveBackend({ uid: () => 0, find: names => names[0], run: async () => ({
      stdout: Buffer.from(JSON.stringify({ ok: true, virtualMachines: [
        { vmid: 101, displayId: "pve:101", status: "running", graphicalConsole: "unknown", inputAvailable: false, qmpPermission: "denied" },
        { vmid: 102, displayId: "pve:102", status: "stopped", graphicalConsole: "unknown", inputAvailable: false, qmpPermission: "unknown" }
      ] })), stderr: Buffer.alloc(0), exitCode: 0
    }) });
    expect(await backend.inspect(context)).toMatchObject({ permissions: { qmp: "denied" }, actions: [], details: { scrollDirections: ["up", "down"] } });
  });

  it("rejects horizontal scrolling before invoking a helper or sending any input", async () => {
    let runs = 0;
    const backend = createPveBackend({ uid: () => 0, find: names => names[0], run: async () => {
      runs++;
      throw new Error("A rejected horizontal scroll must never invoke the helper");
    } });
    const target = { id: "pve:101", instanceId: "pve:101:fixture", x: 0, y: 0, width: 8, height: 6 };
    for (const direction of ["left", "right"] as const) {
      await expect(backend.act({ type: "scroll", direction, amount: 3 }, target, context))
        .rejects.toMatchObject({ code: "unsupported_action", details: { mayHaveApplied: false } });
    }
    expect(runs).toBe(0);
  });
});
