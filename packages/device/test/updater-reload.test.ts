import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { readUpdateStatus, requestWorkerReload } from "../src/updater.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Event { event: string; pid: number; paused: boolean; enabled: boolean; requestId?: string }
function fixture(mode: "normal" | "kernel" | "busy" | "unready" | "race") {
  // Preserve test evidence. No cleanup deletes files, including on assertion failure.
  const root = mkdtempSync(join(tmpdir(), "relay-local-reload-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const entryPoint = join(root, "worker.cjs");
  const previousEntry = join(root, "previous.cjs");
  const eventsFile = join(root, "events.jsonl");
  const sidecar = join(root, "computer-enabled.json");
  const config = join(root, "device.json");
  const originalConfig = '{"deviceId":"test-device","token":"test-token-preserved"}\n';
  writeFileSync(config, originalConfig);
  writeFileSync(eventsFile, "");
  const source = [
    'const fs = require("node:fs");',
    'const version = "1.0.0";',
    'if (process.argv.includes("--version")) { process.stdout.write(version+"\\n"); process.exit(0); }',
    'const [events, sidecar, mode] = process.argv.slice(2);',
    'const paused = process.env.MCP_RELAY_START_DRAINED === "1";',
    'const enabled = fs.existsSync(sidecar) && JSON.parse(fs.readFileSync(sidecar,"utf8")).enabled !== false;',
    'const record = (event,requestId) => fs.appendFileSync(events,JSON.stringify({event,pid:process.pid,paused,enabled,requestId})+"\\n");',
    'record("start");',
    'const publishReady = () => process.send({type:"relay:ready",version});',
    'if (!(mode === "unready" && paused)) {',
    ' if (mode === "race" && paused) { const timer=setInterval(()=>{if(fs.existsSync(events+".allow-ready")){clearInterval(timer);publishReady();}},10); }',
    ' else setTimeout(publishReady,20);',
    '}',
    'process.on("message", message=>{',
    ' if (message.type === "relay:drain") {',
    '  record("drain",message.requestId);',
    '  if (mode === "kernel") process.send({type:"relay:drain-deferred",requestId:message.requestId,reason:"kernel state is active; reset kernel to allow update"});',
    '  else if (mode === "race" && !paused) {',
    '   const timer=setInterval(()=>{if(fs.existsSync(events+".allow-drain")){clearInterval(timer);record("flushed");process.send({type:"relay:drained",requestId:message.requestId});}},10);',
    '  } else {',
    '   if (mode === "busy") record("task-begun");',
    '   setTimeout(()=>{record(mode==="busy"?"task-finished":"flushed");process.send({type:"relay:drained",requestId:message.requestId});},mode==="busy"?400:0);',
    '  }',
    ' } else if (message.type === "relay:resume") record(message.requestId.startsWith("activate-")?"activated":"resumed",message.requestId);',
    ' else if (message.type === "relay:shutdown") {record("shutdown");process.exit(0);}',
    '});',
    'process.on("disconnect",()=>process.exit(0));'
  ].join("\n");
  writeFileSync(entryPoint, source);
  const previousSource = source.replace('const version = "1.0.0";', 'const version = "0.9.0";');
  writeFileSync(previousEntry, previousSource);
  const current = { version: "1.0.0", sha256: hash(source), entryPoint };
  const previous = { version: "0.9.0", sha256: hash(previousSource), entryPoint: previousEntry };
  const failed = { version: "0.8.0", sha256: "f".repeat(64), retryAfter: Date.now() + 60000, reason: "older candidate previously rejected" };
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({
    schemaVersion: 1, phase: "running", current, previous, failed, updatedAt: Date.now()
  }));
  const requestsFile = join(root, "requests.jsonl");
  writeFileSync(requestsFile, "");
  let child: ChildProcess | undefined;
  let completion: Promise<number | null> | undefined;
  let exited = false;
  let failure: unknown;
  let logs = "";
  const requests = () => readFileSync(requestsFile, "utf8").split("\n").filter(Boolean).length;
  const events = (): Event[] => readFileSync(eventsFile, "utf8").split("\n").flatMap(line => {
    try { return line ? [JSON.parse(line) as Event] : []; } catch { return []; }
  });
  return {
    root, stateDir, sidecar, events, config, originalConfig, current, previous, failed,
    allowInitialDrain: () => writeFileSync(eventsFile + ".allow-drain", "ready"),
    allowCandidateReady: () => writeFileSync(eventsFile + ".allow-ready", "ready"),
    requests,
    supervisorPid: () => child?.pid,
    state: () => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")),
    status: () => readUpdateStatus(stateDir),
    async start(underLauncher = false) {
      const updaterPath = fileURLToPath(new URL("../src/updater.ts", import.meta.url));
      const supervisorEntry = join(root, "supervisor.cjs");
      const options = {
        entryPoint, version: "1.0.0", args: [eventsFile, sidecar, mode],
        relayUrl: "https://relay.example", stateDir,
        pollIntervalMs: 60000, drainTimeoutMs: mode === "busy" ? 60 : mode === "race" ? 3000 : 500,
        readyTimeoutMs: mode === "race" ? 3000 : 700, stabilityMs: 80
      };
      const contents = [
        "import { runSupervisor } from " + JSON.stringify(updaterPath) + ";",
        'import { appendFileSync } from "node:fs";',
        'const controller = new AbortController();',
        'process.on("message", m => { if (m?.type === "fixture:stop") controller.abort(); });',
        'const options = ' + JSON.stringify(options) + ';',
        'const manifest = ' + JSON.stringify({ schemaVersion: 1, version: "1.0.0", sha256: hash(source), url: "/unused.cjs" }) + ';',
        'const fetcher = async () => { appendFileSync(' + JSON.stringify(requestsFile) + ',"request\\n"); return new Response(JSON.stringify(manifest)); };',
        'runSupervisor({...options,signal:controller.signal,log(m){process.stderr.write(m+"\\n");}},{fetch:fetcher})',
        '.then(code=>{process.exitCode=code;process.disconnect?.();})',
        '.catch(error=>{process.stderr.write(error.stack+"\\n");process.exitCode=2;process.disconnect?.();});'
      ].join("\n");
      await build({
        stdin: { contents, resolveDir: dirname(updaterPath), sourcefile: "reload-supervisor-fixture.ts", loader: "ts" },
        outfile: supervisorEntry, platform: "node", format: "cjs", bundle: true, target: "node22", logLevel: "silent"
      });
      child = fork(supervisorEntry, [], {
        execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, MCP_RELAY_LAUNCHED: underLauncher ? "1" : "0",
          MCP_RELAY_SUPERVISOR: "1", MCP_RELAY_WORKER: "0", MCP_RELAY_START_DRAINED: "0" }
      });
      child.stdout?.on("data", chunk => { logs = (logs + String(chunk)).slice(-6000); });
      child.stderr?.on("data", chunk => { logs = (logs + String(chunk)).slice(-6000); });
      child.on("error", error => { failure = error; });
      child.on("message", message => {
        const value = message as { type?: string; activateRequired?: boolean };
        if (value.type === "relay:supervisor-ready" && value.activateRequired) child?.send({ type: "relay:launcher-activate" });
      });
      completion = new Promise(done => child!.once("exit", code => { exited = true; done(code); }));
    },
    async wait(predicate: () => boolean) {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (failure) throw failure;
        if (exited) throw new Error("reload supervisor exited unexpectedly: " + logs);
        if (predicate()) return;
        await delay(20);
      }
      throw new Error("reload fixture timed out: " + JSON.stringify(readUpdateStatus(stateDir)));
    },
    async baseline() {
      await this.wait(() => (this.status().lastResult as { status?: string })?.status === "current");
      return requests();
    },
    async stop() {
      if (!child || !completion) return;
      if (!exited && child.connected) child.send({ type: "fixture:stop" });
      const end = Date.now() + 10000;
      while (!exited && Date.now() < end) await delay(20);
      if (!exited) {
        child.kill("SIGKILL");
        await completion;
        throw new Error("reload supervisor did not shut down cleanly: " + logs);
      }
      expect(await completion).toBe(0);
    }
  };
}

describe("local verified worker reload", () => {
  it("reloads the sidecar after drain without network, history changes or controller handoff, and consumes once", async () => {
    const h = fixture("normal");
    await h.start(true);
    try {
      const networkBefore = await h.baseline();
      const supervisorPid = h.supervisorPid();
      expect(h.events().find(event => event.event === "start")?.enabled).toBe(false);
      writeFileSync(h.sidecar, '{"computerEnabled":true}\n');
      await requestWorkerReload(h.stateDir);
      const request = readFileSync(join(h.stateDir, "reload-request.json"), "utf8");
      await requestWorkerReload(h.stateDir);
      expect(readFileSync(join(h.stateDir, "reload-request.json"), "utf8")).toBe(request);
      await h.wait(() => (h.status().reload as { status?: string })?.status === "completed");
      await h.wait(() => h.events().some(event => event.event === "activated"));
      const events = h.events();
      expect(events.findIndex(event => event.event === "shutdown")).toBeGreaterThan(events.findIndex(event => event.event === "flushed"));
      const starts = events.filter(event => event.event === "start");
      expect(starts).toHaveLength(2);
      expect(starts[1]).toMatchObject({ paused: true, enabled: true });
      expect(h.state()).toMatchObject({ current: h.current, previous: h.previous, failed: h.failed });
      expect(h.state().pending).toBeUndefined();
      expect(h.state().handoff).toBeUndefined();
      expect(h.supervisorPid()).toBe(supervisorPid);
      expect(readFileSync(h.config, "utf8")).toBe(h.originalConfig);
      expect(h.requests()).toBe(networkBefore);
      await delay(1200);
      expect(h.events().filter(event => event.event === "start")).toHaveLength(2);
    } finally { await h.stop(); }
  }, 15000);

  it("keeps a kernel-blocked request pending and resumes the same real worker without shutdown", async () => {
    const h = fixture("kernel");
    await h.start();
    try {
      const networkBefore = await h.baseline();
      writeFileSync(h.sidecar, "{}");
      await requestWorkerReload(h.stateDir);
      await h.wait(() => (h.status().reload as { status?: string })?.status === "deferred");
      await h.wait(() => h.events().some(event => event.event === "resumed"));
      expect(h.status().reload).toMatchObject({ status: "deferred", reason: "kernel state is active; reset kernel to allow update" });
      expect(h.events().filter(event => event.event === "start")).toHaveLength(1);
      expect(h.events().some(event => event.event === "shutdown")).toBe(false);
      const request = readFileSync(join(h.stateDir, "reload-request.json"), "utf8");
      await requestWorkerReload(h.stateDir);
      expect(readFileSync(join(h.stateDir, "reload-request.json"), "utf8")).toBe(request);
      expect(h.requests()).toBe(networkBefore);
    } finally { await h.stop(); }
  }, 15000);

  it("lets an in-flight task finish after a drain timeout and does not stop its worker", async () => {
    const h = fixture("busy");
    await h.start();
    try {
      await h.baseline();
      await requestWorkerReload(h.stateDir);
      await h.wait(() => (h.status().reload as { status?: string })?.status === "deferred");
      await h.wait(() => h.events().some(event => event.event === "task-finished"));
      const events = h.events();
      expect(events.some(event => event.event === "resumed")).toBe(true);
      expect(events.some(event => event.event === "shutdown")).toBe(false);
      expect(events.filter(event => event.event === "start")).toHaveLength(1);
      expect(events.find(event => event.event === "task-begun")?.pid).toBe(events.find(event => event.event === "task-finished")?.pid);
    } finally { await h.stop(); }
  }, 15000);

  it("rejects an unready paused replacement, restores the verified worker, and preserves release rollback history", async () => {
    const h = fixture("unready");
    await h.start();
    try {
      const networkBefore = await h.baseline();
      writeFileSync(h.sidecar, "{}");
      await requestWorkerReload(h.stateDir);
      await h.wait(() => (h.status().reload as { status?: string })?.status === "failed");
      await h.wait(() => h.events().filter(event => event.event === "start").length === 3);
      const starts = h.events().filter(event => event.event === "start");
      expect(starts.map(event => event.paused)).toEqual([false, true, false]);
      expect(h.events().some(event => event.event === "activated")).toBe(false);
      expect(h.status()).toMatchObject({ version: "1.0.0", previousVersion: "0.9.0", reload: { status: "failed" } });
      expect(h.state()).toMatchObject({ current: h.current, previous: h.previous, failed: h.failed });
      expect(h.requests()).toBe(networkBefore);
      await delay(1200);
      expect(h.events().filter(event => event.event === "start")).toHaveLength(3);
      expect(readFileSync(h.config, "utf8")).toBe(h.originalConfig);
    } finally { await h.stop(); }
  }, 15000);

  it("does not let an earlier candidate's ready consume a newer desired-settings revision", async () => {
    const h = fixture("race");
    await h.start(true);
    try {
      const networkBefore = await h.baseline();
      writeFileSync(h.sidecar, '{"enabled":true}');
      await requestWorkerReload(h.stateDir, "settings-revision-A");
      const requestA = JSON.parse(readFileSync(join(h.stateDir, "reload-request.json"), "utf8"));
      await h.wait(() => h.events().some(event => event.event === "drain"));

      // An independent disable occurs while A is draining. The paused candidate
      // really reads disabled from disk, then waits before publishing readiness.
      writeFileSync(h.sidecar, '{"enabled":false}');
      h.allowInitialDrain();
      await h.wait(() => h.events().filter(event => event.event === "start").length === 2);
      expect(h.events().filter(event => event.event === "start")[1]).toMatchObject({ paused: true, enabled: false });

      // The later enable has the same effective true value as A, but a different
      // settings revision. It must remain a distinct request after A becomes ready.
      writeFileSync(h.sidecar, '{"enabled":true}');
      await requestWorkerReload(h.stateDir, "settings-revision-B");
      const requestB = JSON.parse(readFileSync(join(h.stateDir, "reload-request.json"), "utf8"));
      expect(requestB.id).not.toBe(requestA.id);
      expect(requestB.requestKey).toBe("settings-revision-B");
      await requestWorkerReload(h.stateDir, "settings-revision-B");
      expect(JSON.parse(readFileSync(join(h.stateDir, "reload-request.json"), "utf8")).id).toBe(requestB.id);
      h.allowCandidateReady();

      await h.wait(() => {
        const reload = h.status().reload as { id?: string; status?: string };
        return reload?.id === requestB.id && reload.status === "completed";
      });
      const starts = h.events().filter(event => event.event === "start");
      expect(starts.map(event => event.enabled)).toEqual([false, false, true]);
      expect(starts[2]).toMatchObject({ paused: true, enabled: true });
      expect(h.status().reload).toMatchObject({ id: requestB.id, requestKey: "settings-revision-B", status: "completed" });
      expect(h.state()).toMatchObject({ current: h.current, previous: h.previous, failed: h.failed });
      expect(h.requests()).toBe(networkBefore);
      await delay(1200);
      expect(h.events().filter(event => event.event === "start")).toHaveLength(3);
    } finally { await h.stop(); }
  }, 15000);
});
