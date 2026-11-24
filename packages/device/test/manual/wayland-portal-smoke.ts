import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createWaylandBackend } from "../../src/computer/wayland.js";
import { pngDimensions } from "../../src/computer/native.js";
import type { ComputerAction, ComputerDisplay, ComputerState, NativeContext } from "../../src/computer/types.js";

type Observation = {
  displayType: string; text: string; clicks: number; drags: number; motion: number;
  scrollX: number; scrollY: number; buttons: number[]; keys: string[];
  logicalWidth: number; logicalHeight: number; gdkScale: number;
  lastPointer: [number, number];
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const outcome = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

async function main(): Promise<void> {
  assert.equal(process.env.RELAY_WAYLAND_NATIVE_TEST, "nested-mutter-private-bus");
  const evidence = process.env.RELAY_NATIVE_EVIDENCE_DIR!;
  assert.ok(evidence?.startsWith("/"), "Evidence must be outside the checkout");
  assert.equal(process.env.XDG_RUNTIME_DIR, evidence + "/runtime");
  assert.equal(process.env.WAYLAND_DISPLAY, "wayland-relay-native");
  assert.equal(process.env.XDG_SESSION_TYPE, "wayland");
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS);
  const fixtureScript = resolve("packages/device/test/manual/wayland-portal-smoke.py");
  const fixtureEnv: NodeJS.ProcessEnv = { ...process.env, GDK_BACKEND: "wayland",
    GST_DEBUG: "2,pipewiresrc:5", GST_DEBUG_FILE: join(evidence, "gstreamer.log") };
  delete fixtureEnv.DISPLAY;
  const backend = createWaylandBackend(fixtureEnv);
  const checks: string[] = [];
  const layouts: Record<string, any>[] = [];
  const fixtureScales = new WeakMap<ComputerDisplay, number>();
  const expectedScale = Number(process.env.RELAY_TEST_SCALE ?? "1");
  const expectedTransport = process.env.RELAY_TEST_INPUT_TRANSPORT;
  assert.ok(expectedTransport === "eis" || expectedTransport === "gnome-legacy");
  let observed: Partial<Observation> = {};
  let diagnostic = "";
  let fixture: ChildProcessWithoutNullStreams | undefined;
  mkdirSync(evidence, { recursive: true });
  const context = (timeoutMs = 15000): NativeContext => ({ timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  function passed(description: string): void {
    checks.push(description);
    process.stdout.write("Native check passed: " + description + "\n");
  }

  async function until(test: () => boolean, description: string, timeoutMs = 10000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!test() && Date.now() < end) await delay(30);
    assert.ok(test(), description + "; observed=" + JSON.stringify(observed) + "; fixture=" + diagnostic);
  }
  async function python(mode: string, args: string[] = [], input?: Buffer): Promise<Record<string, any>> {
    const child = spawn("/usr/bin/python3", ["-u", fixtureScript, mode, ...args], {
      env: fixtureEnv, stdio: ["pipe", "pipe", "pipe"], shell: false
    });
    let output = "", stderr = "";
    child.stdout.on("data", bytes => { output += String(bytes); });
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-32000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    const exit = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
      child.stdin.end(input);
    }).finally(() => clearTimeout(timer));
    assert.equal(exit, 0, "Native fixture " + mode + ": " + output + "\n" + stderr);
    return JSON.parse(output.trim());
  }
  async function authorize(requireInput = true): Promise<ComputerState> {
    const pending = outcome(backend.setup!(context(30000)));
    const clicked = await python("allow");
    assert.equal(clicked.dialogAction, "Share");
    process.stdout.write("Native consent: " + JSON.stringify(clicked) + "\n");
    const result = await pending;
    if (result.ok === false) throw result.error;
    const state = await backend.inspect(context());
    assert.equal(state.available, true, JSON.stringify(state));
    assert.equal(state.backend, "linux-wayland-portal");
    assert.equal(state.permissions.screenCapture, "granted");
    if (requireInput) {
      assert.equal(state.inputKind, "mouse_keyboard", JSON.stringify(state));
      assert.equal(state.permissions.input, "granted");
      assert.equal(state.details?.inputTransport, expectedTransport, "The native job must exercise its assigned input transport");
    } else {
      assert.equal(state.inputKind, "none", "Unsafe legacy mapping must preserve capture without exposing input");
      assert.notEqual(state.permissions.input, "granted");
      assert.deepEqual(state.actions, []);
    }
    assert.ok(state.displays.length > 0);
    fixture!.stdin.write(JSON.stringify({ operation: "present" }) + "\n");
    await delay(300);
    return state;
  }
  function pixel(display: ComputerDisplay, x: number, y: number) {
    const fixtureScale = fixtureScales.get(display);
    assert.ok(fixtureScale, "Only a captured frame with independently observed fixture geometry may be used");
    // The actual native GTK fixture determines pixel coordinates. Depending
    // on compositor EIS units, backend scaleX may legitimately differ from
    // GDK scale; using it here would test the implementation against itself.
    return { x: Math.round(x * fixtureScale), y: Math.round(y * fixtureScale) };
  }
  async function act(action: ComputerAction, display: ComputerDisplay): Promise<void> {
    const result = await backend.act(action, display, context());
    assert.equal(result.submitted, true);
    assert.equal(result.verified, false, "Submission acknowledgements are not UI verification");
  }
  async function screenshot(name: string) {
    const frame = await backend.screenshot(undefined, context());
    assert.deepEqual(pngDimensions(frame.data), { width: frame.display.width, height: frame.display.height });
    assert.ok(frame.display.instanceId);
    assert.equal(frame.display.width, Number(observed.logicalWidth) * Number(observed.gdkScale), "PNG width must match the independent fullscreen GTK allocation");
    assert.equal(frame.display.height, Number(observed.logicalHeight) * Number(observed.gdkScale), "PNG height must match the independent fullscreen GTK allocation");
    fixtureScales.set(frame.display, Number(observed.gdkScale));
    writeFileSync(join(evidence, name + ".png"), frame.data, { mode: 0o600 });
    return frame;
  }
  async function assertColors(data: Buffer, display: ComputerDisplay, clicked: boolean) {
    const samples = [[10, 300], [60, 150]].map(([x, y]) => {
      const p = pixel(display, x!, y!); return [p.x, p.y];
    });
    const decoded = await python("png", [JSON.stringify(samples)], data);
    const expected = [[36, 91, 160], clicked ? [29, 181, 83] : [211, 51, 63]];
    for (let i = 0; i < expected.length; i++) {
      assert.ok(expected[i]!.every((value, channel) => Math.abs(decoded.samples[i][channel] - value) <= 3),
        "PipeWire image must contain actual native fixture pixels: " + JSON.stringify(decoded));
    }
  }
  function helperIdentity(): { pid: number; start: string } {
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    const matches = children.flatMap(value => {
      const pid = Number(value);
      if (pid === fixture?.pid) return [];
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!argv.includes("-I") || !argv.includes("-c") || !argv.some(arg => arg.includes("org.freedesktop.portal.Desktop"))) return [];
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        assert.equal(Number(fields[1]), process.pid);
        return [{ pid, start: fields[19]! }];
      } catch { return []; }
    });
    assert.equal(matches.length, 1, "Exactly one owned native helper must exist");
    return matches[0]!;
  }

  try {
    fixture = spawn("/usr/bin/python3", ["-u", fixtureScript, "fixture"], {
      env: fixtureEnv, stdio: ["pipe", "pipe", "pipe"], shell: false
    });
    const lines = createInterface({ input: fixture.stdout });
    lines.on("line", line => { observed = JSON.parse(line); });
    fixture.stderr.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-16000); });
    fixture.once("exit", (code, signal) => { diagnostic += ` fixture-exit=${code}/${signal}`; });
    await until(() => Boolean(observed.displayType) && Number(observed.logicalWidth) >= 640, "Native GTK fixture readiness");
    assert.match(observed.displayType!, /Wayland/);
    passed("fixture is a native GTK Wayland client with no DISPLAY fallback");

    const before = await backend.inspect(context());
    assert.equal(before.available, false, JSON.stringify(before));
    assert.equal((await python("absent")).dialogAbsent, true);
    passed("inspection does not request permission or show a consent dialog");

    const cancelled = outcome(backend.setup!(context(30000)));
    assert.equal((await python("cancel")).dialogAction, "Cancel");
    assert.equal((await cancelled).ok, false);
    assert.equal((await backend.inspect(context())).available, false);
    assert.equal((await python("absent")).dialogAbsent, true);
    passed("real system consent cancellation leaves no authorized session");

    const timed = outcome(backend.setup!(context(1500)));
    assert.equal((await timed).ok, false);
    assert.equal((await python("absent")).dialogAbsent, true);
    passed("consent deadline closes the real dialog and does not leave a grant");

    const state = await authorize();
    const first = await screenshot("before-input");
    await assertColors(first.data, first.display, false);
    passed("real portal consent returns PipeWire PNG containing the native fixture");
    const screen = first.display;
    assert.equal(observed.gdkScale, expectedScale, "Compositor fixture scale");
    passed("PNG pixel geometry agrees with independently observed native GTK allocation and scale");
    const staticFrame = await screenshot("static-recapture");
    await assertColors(staticFrame.data, staticFrame.display, false);
    passed("an unchanged desktop can be captured again without stale-frame timeout");

    await act({ type: "click", ...pixel(screen, 100, 40) }, screen);
    const ascii = "Relay 42 !@#:/[]{}?";
    if (expectedTransport === "eis") {
      assert.ok(state.actions.includes("key") && state.actions.includes("text"));
      await act({ type: "text", text: ascii }, screen);
      await until(() => observed.text === ascii, "Actual GTK entry receives uppercase and punctuation");
      await until(() => observed.keys?.length === 0, "All printable ASCII modifiers and keys are released");
      await act({ type: "key", keys: ["Control_L", "a"] }, screen);
      await act({ type: "text", text: "replacement" }, screen);
      await until(() => observed.text === "replacement", "Actual selection chord and replacement");
      passed("EIS uppercase ASCII, punctuation and keyboard chords affect the native GTK entry");
    } else {
      assert.ok(!state.actions.includes("key") && !state.actions.includes("text"));
      for (const action of [{ type: "text", text: ascii }, { type: "key", keys: ["Control_L", "a"] }] as ComputerAction[]) {
        await assert.rejects(() => backend.act(action, screen, context()), { code: "keyboard_unavailable" });
      }
      await delay(150);
      assert.equal(observed.text, "", "Unsupported legacy keyboard input must not alter the native GTK entry");
      assert.deepEqual(observed.keys, []);
      passed("legacy advertises pointer-only control and atomically refuses text and keyboard chords");
    }
    assert.equal(state.unicodeText, false);
    await assert.rejects(() => backend.act({ type: "text", text: "partial中文" }, screen, context()));
    await delay(100);
    assert.equal(observed.text, expectedTransport === "eis" ? "replacement" : "", "Unsupported text must not be partially entered");
    passed("unsupported Unicode is refused before partial text input");

    await act({ type: "click", ...pixel(screen, 100, 100) }, screen);
    await until(() => observed.clicks === 1, "Actual GTK button click");
    const after = await screenshot("after-input");
    await assertColors(after.data, after.display, true);
    passed("native click changes a fixture pixel marker visible in the next PipeWire frame");
    const dragStart = pixel(screen, 70, 240), dragEnd = pixel(screen, 420, 330);
    await act({ type: "drag", fromX: dragStart.x, fromY: dragStart.y,
      toX: dragEnd.x, toY: dragEnd.y, durationMs: 400 }, screen);
    await until(() => Number(observed.drags) > 0, "Native held-button drag events");
    passed("native Wayland drag delivers held-button motion");
    await act({ type: "scroll", direction: "down", amount: 3, ...pixel(screen, 300, 260) }, screen);
    await until(() => Number(observed.scrollY) > 0, "Vertical native scroll");
    await act({ type: "scroll", direction: "right", amount: 2, ...pixel(screen, 300, 260) }, screen);
    await until(() => Number(observed.scrollX) > 0, "Horizontal native scroll");
    passed("both scroll axes reach the native GTK widget");

    const abort = new AbortController();
    const beforeCancelledDrag = Number(observed.drags);
    const interrupted = outcome(backend.act({ type: "drag", fromX: dragStart.x, fromY: dragStart.y,
      toX: dragEnd.x, toY: dragEnd.y, durationMs: 4000 }, screen, { timeoutMs: 10000, signal: abort.signal }));
    await until(() => Number(observed.drags) > beforeCancelledDrag, "Cancellable drag delivers actual held-button motion");
    abort.abort();
    assert.equal((await interrupted).ok, false);
    await authorize();
    let current = await screenshot("after-cancellation");
    let drags = observed.drags;
    await act({ type: "move", ...pixel(current.display, 530, 380) }, current.display);
    await delay(150);
    assert.equal(observed.drags, drags, "Cancellation must not leak a held button into later input");
    passed("cancellation releases held input before a newly authorized session");

    const identity = helperIdentity();
    const from = pixel(current.display, 80, 250), to = pixel(current.display, 480, 350);
    const beforeDyingDrag = Number(observed.drags);
    const dying = outcome(backend.act({ type: "drag", fromX: from.x, fromY: from.y,
      toX: to.x, toY: to.y, durationMs: 4000 }, current.display, context(10000)));
    await until(() => Number(observed.drags) > beforeDyingDrag, "Crash fixture delivers actual held-button motion");
    assert.deepEqual(helperIdentity(), identity, "Only the exact owned helper process may be stopped");
    process.kill(identity.pid, "SIGKILL");
    assert.equal((await dying).ok, false);
    assert.equal((await backend.inspect(context())).available, false);
    await assert.rejects(() => backend.act({ type: "move", ...pixel(current.display, 500, 350) }, current.display, context()));
    await authorize();
    current = await screenshot("after-helper-crash");
    assert.notEqual(current.display.instanceId, screen.instanceId, "A new grant must have a new display instance");
    await assert.rejects(() => backend.act({ type: "move", ...pixel(screen, 300, 250) }, screen, context()));
    drags = observed.drags;
    await act({ type: "move", ...pixel(current.display, 550, 390) }, current.display);
    await until(() => Boolean(observed.lastPointer) && Math.abs(observed.lastPointer![0] - 550) <= 2 &&
      Math.abs(observed.lastPointer![1] - 390) <= 2, "Native GTK verifies a pointer target beyond half the physical image at scale2");
    assert.equal(observed.drags, drags, "Compositor must release input from the dead portal client");
    passed("helper death closes its grant, releases input and rejects old display instances");

    const stale = current;
    const changedScale = expectedScale === 1 ? 2 : 1;
    const layout = await python("scale", [String(changedScale)]);
    assert.equal(layout.modeUnchanged, true);
    assert.deepEqual(layout.physicalBefore, [1600, 1200]);
    assert.deepEqual(layout.physicalAfter, layout.physicalBefore);
    assert.equal(layout.scaleAfter, changedScale);
    layouts.push(layout);
    await until(() => observed.gdkScale === changedScale &&
      Number(observed.logicalWidth) * changedScale === 1600, "Actual native client receives the compositor scale change");
    const clicksBeforeLayout = Number(observed.clicks);
    await assert.rejects(() => backend.act({ type: "click", ...pixel(stale.display, 100, 100) }, stale.display, context()));
    await delay(150);
    assert.equal(observed.clicks, clicksBeforeLayout, "A stale physical-size frame must never click after logical scale changes");
    passed("real compositor scale change with identical physical resolution fences stale input");
    const layoutCapture = await screenshot("after-layout-change");
    await assertColors(layoutCapture.data, layoutCapture.display, true);
    passed("capture remains usable after the input mapping is invalidated");

    await backend.close?.();
    if (expectedTransport === "gnome-legacy") {
      await authorize(false);
      const captureOnly = await screenshot("legacy-scale2-capture-only");
      await assertColors(captureOnly.data, captureOnly.display, true);
      await assert.rejects(() => backend.act({ type: "click", ...pixel(captureOnly.display, 100, 100) }, captureOnly.display, context()));
      assert.equal(observed.clicks, clicksBeforeLayout);
      passed("legacy GNOME scale2 explicitly permits capture and refuses unsupported input");
      await backend.close?.();
      layouts.push(await python("scale", ["1"]));
      await until(() => observed.gdkScale === 1 && observed.logicalWidth === 1600, "Legacy test returns to scale1");
    }
    await authorize();
    current = await screenshot("reauthorized-layout");
    await act({ type: "click", ...pixel(current.display, 100, 100) }, current.display);
    await until(() => observed.clicks === clicksBeforeLayout + 1, "A newly authorized native mapping clicks after a real layout change");
    passed(expectedTransport === "eis"
      ? "EIS reauthorization maps real input correctly at the newly applied compositor scale"
      : "explicit reauthorization at supported legacy scale1 restores actual native input");

    const portalPid = Number(process.env.RELAY_TEST_PORTAL_PID);
    assert.ok(Number.isSafeInteger(portalPid) && portalPid > 1, "Only the explicitly spawned test portal may be stopped");
    process.kill(portalPid, "SIGTERM");
    await delay(500);
    assert.equal((await backend.inspect(context())).available, false);
    await assert.rejects(() => backend.act({ type: "click", ...pixel(current.display, 100, 100) }, current.display, context()));
    assert.equal((await python("absent")).dialogAbsent, true, "Owner loss must not silently request another grant");
    passed("real portal owner loss revokes input without silent reauthorization");

    const receipt = { ok: true, backend: backend.id, checks, observed, display: screen, layouts,
      inputTransport: expectedTransport,
      sourceRevision: process.env.GITHUB_SHA ?? null,
      harnessSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"),
      fixtureSha256: createHash("sha256").update(readFileSync(fixtureScript)).digest("hex"),
      compositor: "Mutter nested Wayland; no XWayland; real GNOME portal and PipeWire", scale: expectedScale };
    writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  } catch (error) {
    const failure = { ok: false, checks, observed, diagnostic,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) };
    writeFileSync(join(evidence, "failure.json"), JSON.stringify(failure, null, 2) + "\n", { mode: 0o600 });
    process.stderr.write("Native failure: " + JSON.stringify(failure) + "\n");
    throw error;
  } finally {
    await backend.close?.();
    fixture?.stdin.end(JSON.stringify({ operation: "quit" }) + "\n");
    if (fixture?.exitCode === null && fixture.signalCode === null) {
      fixture.kill("SIGTERM");
      await new Promise<void>(resolveExit => {
        const timer = setTimeout(() => { fixture?.kill("SIGKILL"); resolveExit(); }, 1000);
        fixture!.once("exit", () => { clearTimeout(timer); resolveExit(); });
      });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
