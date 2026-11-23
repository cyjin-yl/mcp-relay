import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createLinuxBackend } from "../../src/computer/linux.js";
import { nativeEnvironment, pngDimensions } from "../../src/computer/native.js";

assert.ok(process.env.DISPLAY?.startsWith(":"), "A dedicated DISPLAY is required");
assert.equal(process.env.RELAY_COMPUTER_TEST_DISPLAY, process.env.DISPLAY, "Mark the isolated test display explicitly");
const source = [
  "import json, tkinter as tk",
  "r=tk.Tk();r.title('Relay Computer Test');r.overrideredirect(True);r.geometry('640x420+0+0')",
  "s={'clicks':0,'drags':0,'wheel':0}",
  "e=tk.Entry(r,font=('Sans',18));e.place(x=20,y=20,width=570,height=40)",
  "b=tk.Button(r,text='Test button',command=lambda:s.__setitem__('clicks',s['clicks']+1));b.place(x=20,y=80,width=180,height=40)",
  "c=tk.Canvas(r,bg='#74a7d8');c.place(x=20,y=150,width=570,height=220)",
  "c.bind('<B1-Motion>',lambda e:s.__setitem__('drags',s['drags']+1))",
  "c.bind('<Button-4>',lambda e:s.__setitem__('wheel',s['wheel']+1))",
  "c.bind('<Button-5>',lambda e:s.__setitem__('wheel',s['wheel']-1))",
  "last=None",
  "def report():",
  " global last",
  " current={**s,'text':e.get()}",
  " if current!=last: print(json.dumps(current,ensure_ascii=False),flush=True);last=current",
  " r.after(25,report)",
  "r.after(50,lambda:(r.lift(),r.focus_force(),e.focus_set()));r.after(100,report);r.mainloop()"
].join("\n");
const probe = spawn("python3", ["-u", "-c", source], { env: nativeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
const lines = createInterface({ input: probe.stdout });
let observed: Record<string, any> = {}, errors = "";
lines.on("line", line => { observed = JSON.parse(line); });
probe.stderr.on("data", chunk => { errors += String(chunk); });
probe.on("exit", (code, signal) => { errors += " probe-exit=" + code + "/" + signal; });
async function until(predicate: () => boolean, reason: string) {
  const deadline = Date.now() + 20000;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), reason + "; observed=" + JSON.stringify(observed) + "; stderr=" + errors);
}
const backend = createLinuxBackend();
const context = () => ({ timeoutMs: 10000, signal: AbortSignal.timeout(10000) });
const checks: string[] = [];
try {
  await until(() => "text" in observed, "Probe readiness");
  const state = await backend.inspect(context());
  assert.equal(state.available, true, JSON.stringify(state));
  const first = await backend.screenshot(undefined, context());
  assert.deepEqual(pngDimensions(first.data), { width: 1024, height: 768 });
  checks.push("native PNG/physical geometry");
  const screen = first.display;
  await backend.act({ type: "click", x: 90, y: 40 }, screen, context());
  await backend.act({ type: "text", text: "中文 Relay 42 🪷" }, screen, context());
  await until(() => observed.text === "中文 Relay 42 🪷", "Exact Unicode text");
  checks.push("Chinese/ASCII/supplementary Unicode");
  await backend.act({ type: "key", keys: ["Home"] }, screen, context());
  await backend.act({ type: "key", keys: ["Shift", "End"] }, screen, context());
  await backend.act({ type: "text", text: "replacement" }, screen, context());
  await until(() => observed.text === "replacement", "Selection chord/replacement");
  checks.push("keyboard chord");
  await backend.act({ type: "click", x: 90, y: 100 }, screen, context());
  await until(() => observed.clicks === 1, "Single button click");
  checks.push("native click");
  await backend.act({ type: "drag", fromX: 70, fromY: 210, toX: 280, toY: 290, durationMs: 300 }, screen, context());
  await until(() => observed.drags > 0, "Held-button drag");
  checks.push("drag");
  await backend.act({ type: "scroll", direction: "down", amount: 3, x: 300, y: 250 }, screen, context());
  await until(() => observed.wheel === -3, "Targeted scroll");
  checks.push("scroll");
  const abort = new AbortController();
  const cancelled = backend.act({ type: "drag", fromX: 80, fromY: 220, toX: 450, toY: 300, durationMs: 3000 },
    screen, { timeoutMs: 5000, signal: abort.signal });
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(cancelled);
  await delay(100);
  const drags = observed.drags;
  await backend.act({ type: "move", x: 500, y: 320 }, screen, context());
  await delay(100);
  assert.equal(observed.drags, drags, "Cancelled drag must release its own button");
  checks.push("cancellation releases held input");
  const after = await backend.screenshot("desktop", context());
  assert.notDeepEqual(first.data, after.data);
  checks.push("fresh screenshot reflects application changes");
  process.stdout.write(JSON.stringify({ ok: true, backend: backend.id, checks, observed,
    display: screen, screenshotBytes: after.data.length }, null, 2) + "\n");
} finally {
  lines.close(); probe.kill("SIGTERM");
  if (probe.exitCode === null && probe.signalCode === null) await once(probe, "exit");
}
