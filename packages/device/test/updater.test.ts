import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireUpdateLock, compareVersions, readUpdateStatus, requestUpdateCheck,
  resolveManifestUrl, runSupervisor, validateUpdateManifest, type SupervisorOptions
} from "../src/updater.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "relay 更新 space-"));
  temporary.push(path);
  return path;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const manifestUrl = "https://relay.example/updates/device/stable.json";

interface Behavior { ready?: boolean; crashMs?: number; drainMs?: number; deferReason?: string }
function workerSource(version: string, behavior: Behavior = {}): string {
  return [
    'const fs = require("node:fs");',
    "const version = " + JSON.stringify(version) + ";",
    "const behavior = " + JSON.stringify(behavior) + ";",
    'if (process.argv.includes("--version")) { process.stdout.write(version + "\\n"); process.exit(0); }',
    'const record = (event) => fs.appendFileSync(process.argv[2], JSON.stringify({version,event,pid:process.pid,at:Date.now(),paused:process.env.MCP_RELAY_START_DRAINED === "1"}) + "\\n");',
    'record("start");',
    'if (behavior.ready !== false) setTimeout(() => process.send({type:"relay:ready",version}), 20);',
    'if (behavior.crashMs) setTimeout(() => process.exit(42), behavior.crashMs);',
    'process.on("message", (message) => {',
    '  if (message.type === "relay:drain") {',
    '    record("drain");',
    '    if (behavior.deferReason) process.send({type:"relay:drain-deferred",requestId:message.requestId,reason:behavior.deferReason});',
    '    else setTimeout(() => { record("result-flushed"); process.send({type:"relay:drained",requestId:message.requestId}); }, behavior.drainMs || 0);',
    '  } else if (message.type === "relay:resume") record(message.requestId.startsWith("activate-") ? "activated" : "resumed");',
    '  else if (message.type === "relay:shutdown") { record("shutdown"); process.exit(0); }',
    '});',
    'process.on("disconnect", () => process.exit(0));'
  ].join("\n");
}
interface Event { version: string; event: string; pid: number; paused: boolean; at?: number }
interface HarnessOptions {
  current?: Behavior;
  candidate?: Behavior;
  candidateSource?: string;
  digest?: string;
  manifestVersion?: string;
  supervisor?: Partial<SupervisorOptions>;
}
function harness(settings: HarnessOptions = {}) {
  const root = temporaryDirectory();
  const entryPoint = join(root, "installed cli.cjs");
  const stateDir = join(root, "update state");
  const eventsFile = join(root, "events.jsonl");
  const configFile = join(root, "device.json");
  const config = '{"token":"preserve-test-token","deviceId":"same-device"}\n';
  const source = workerSource("1.0.0", settings.current);
  const candidate = settings.candidateSource ?? workerSource("1.1.0", settings.candidate);
  writeFileSync(entryPoint, source);
  writeFileSync(configFile, config);
  writeFileSync(eventsFile, "");
  let offeredVersion = settings.manifestVersion ?? "1.1.0";
  let artifactFetches = 0;
  const messages: string[] = [];
  const controller = new AbortController();
  const fetcher = (async (input: unknown) => {
    const url = String(input);
    if (url === manifestUrl) return new Response(JSON.stringify({
      schemaVersion: 1, version: offeredVersion, url: "/artifacts/cli.cjs",
      sha256: settings.digest ?? hash(candidate), minNodeVersion: "22.5.0"
    }));
    if (url === "https://relay.example/artifacts/cli.cjs") {
      artifactFetches++;
      return new Response(candidate);
    }
    throw new Error("unexpected update request");
  }) as typeof globalThis.fetch;
  let running: Promise<number> | undefined;
  let failure: unknown;
  const events = (): Event[] => readFileSync(eventsFile, "utf8").split("\n").flatMap((line) => {
    if (!line) return [];
    try { return [JSON.parse(line) as Event]; } catch { return []; }
  });
  return {
    root, entryPoint, stateDir, source, candidate, configFile, config, events, messages,
    setOffer(version: string) { offeredVersion = version; },
    artifactFetches: () => artifactFetches,
    status: () => readUpdateStatus(stateDir),
    start() {
      running = runSupervisor({
        entryPoint, version: "1.0.0", args: [eventsFile], relayUrl: "https://relay.example",
        stateDir, pollIntervalMs: 60_000, drainTimeoutMs: 500,
        readyTimeoutMs: 2_000, stabilityMs: 200,
        signal: controller.signal, log(message) { messages.push(message); },
        ...settings.supervisor
      }, { fetch: fetcher });
      void running.catch((error) => { failure = error; });
    },
    async wait(predicate: () => boolean, timeout = 7_000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (failure) throw failure;
        if (predicate()) return;
        await delay(20);
      }
      throw new Error("supervisor fixture timed out: " + JSON.stringify(readUpdateStatus(stateDir)));
    },
    async stop() {
      controller.abort();
      if (running) expect(await running).toBe(0);
    }
  };
}

describe("trusted update manifests", () => {
  it("uses the relay stable channel unless another trusted source is explicitly configured", () => {
    expect(resolveManifestUrl("https://relay.example/api")).toBe(manifestUrl);
    expect(resolveManifestUrl("https://relay.example", "https://releases.example/stable.json"))
      .toBe("https://releases.example/stable.json");
    expect(() => resolveManifestUrl("http://relay.example")).toThrow("HTTPS");
  });

  it("pins artifacts to the HTTPS manifest origin and checks runtime requirements", () => {
    const item = { schemaVersion: 1, version: "0.1.7", url: "/downloads/cli.cjs", sha256: "a".repeat(64), minNodeVersion: "22.5.0" };
    expect(validateUpdateManifest(item, manifestUrl, "22.5.0").url).toBe("https://relay.example/downloads/cli.cjs");
    expect(() => validateUpdateManifest({ ...item, url: "https://other.example/cli.cjs" }, manifestUrl)).toThrow("origin");
    expect(() => validateUpdateManifest({ ...item, url: "http://relay.example/cli.cjs" }, manifestUrl)).toThrow("HTTPS");
    expect(() => validateUpdateManifest({ ...item, url: "https://secret@relay.example/cli.cjs" }, manifestUrl)).toThrow("user information");
    expect(() => validateUpdateManifest(item, manifestUrl, "22.4.0")).toThrow("newer Node");
    expect(() => validateUpdateManifest({ ...item, sha256: "bad" }, manifestUrl)).toThrow("manifest");
  });

  it("orders bootstrap, numeric prerelease and stable versions without permitting downgrades", () => {
    expect(compareVersions("0.1.7", "0.1.7-bootstrap.1")).toBe(1);
    expect(compareVersions("0.1.7-bootstrap.10", "0.1.7-bootstrap.2")).toBe(1);
    expect(compareVersions("0.1.6-transport.20261123", "0.1.7")).toBe(-1);
    expect(compareVersions("0.1.7+build.1", "0.1.7+build.2")).toBe(0);
    expect(() => compareVersions("../../wrong", "0.1.7")).toThrow("version");
  });
});

it("holds a single live supervisor lock and releases it without stale files", async () => {
  const directory = temporaryDirectory();
  const release = await acquireUpdateLock(directory);
  try { await expect(acquireUpdateLock(directory)).rejects.toMatchObject({ code: "UPDATE_LOCK_BUSY" }); }
  finally { await release(); }
  const reacquired = await acquireUpdateLock(directory);
  await reacquired();
});

it("updates a real worker only after drain, verifies readiness, then activates the paused candidate", async () => {
  const h = harness();
  h.start();
  try {
    await h.wait(() => h.events().some((event) => event.version === "1.1.0" && event.event === "activated"));
    const events = h.events();
    const oldFlushed = events.findIndex((event) => event.version === "1.0.0" && event.event === "result-flushed");
    const oldStopped = events.findIndex((event) => event.version === "1.0.0" && event.event === "shutdown");
    const candidateStarted = events.findIndex((event) => event.version === "1.1.0" && event.event === "start");
    const candidateActivated = events.findIndex((event) => event.version === "1.1.0" && event.event === "activated");
    expect(oldFlushed).toBeGreaterThanOrEqual(0);
    expect(oldStopped).toBeGreaterThan(oldFlushed);
    expect(candidateStarted).toBeGreaterThan(oldStopped);
    expect(candidateActivated).toBeGreaterThan(candidateStarted);
    expect(events[candidateStarted]?.paused).toBe(true);
    expect(h.status()).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0", phase: "running" });
    expect(readFileSync(h.configFile, "utf8")).toBe(h.config);
    expect(JSON.stringify(h.status())).not.toContain(h.root);
    expect(JSON.stringify(h.status())).not.toContain("preserve-test-token");
    expect(h.artifactFetches()).toBe(1);
  } finally { await h.stop(); }
});

it("rejects a wrong digest before asking the working relay to drain", async () => {
  const h = harness({ digest: "0".repeat(64) });
  h.start();
  try {
    await h.wait(() => Boolean(h.status().failed));
    expect(h.status()).toMatchObject({ version: "1.0.0", failed: { version: "1.1.0", reason: "candidate SHA-256 mismatch" } });
    expect(h.events().map((event) => event.event)).not.toContain("drain");
    expect(h.events().map((event) => event.version)).not.toContain("1.1.0");
    expect(readFileSync(h.configFile, "utf8")).toBe(h.config);
  } finally { await h.stop(); }
});

it.each([
  ["syntax", "const broken = ;"],
  ["missing import", 'require("__missing_relay_update_test_dependency__");\n' + workerSource("1.1.0")],
  ["incorrect version", workerSource("1.2.0")]
])("preflights %s failures while the existing worker stays active", async (_label, candidateSource) => {
  const h = harness({ candidateSource });
  h.start();
  try {
    await h.wait(() => Boolean(h.status().failed));
    expect(h.status().version).toBe("1.0.0");
    expect(h.events().filter((event) => event.event === "start")).toHaveLength(1);
    expect(h.events().some((event) => event.event === "drain")).toBe(false);
  } finally { await h.stop(); }
});

it.each([
  { ready: false },
  { crashMs: 70 }
])("rolls back an unready or unstable candidate and cools down its exact digest (%j)", async (candidate) => {
  const h = harness({ candidate, supervisor: { readyTimeoutMs: 400, stabilityMs: 200 } });
  h.start();
  try {
    await h.wait(() => Boolean(h.status().failed) && h.events().filter((event) => event.version === "1.0.0" && event.event === "start").length === 2);
    expect(h.status().version).toBe("1.0.0");
    expect((h.status().failed as { retryAfter: number }).retryAfter).toBeGreaterThan(Date.now());
    expect(h.events().some((event) => event.version === "1.1.0" && event.event === "activated")).toBe(false);
    await requestUpdateCheck(h.stateDir);
    await h.wait(() => (h.status().lastResult as { status?: string })?.status === "cooldown");
    expect(h.artifactFetches()).toBe(1);
    expect(h.events().filter((event) => event.version === "1.1.0" && event.event === "start")).toHaveLength(1);
  } finally { await h.stop(); }
});

it("defers an update without stopping long-running work when drain times out", async () => {
  const h = harness({ current: { drainMs: 2_000 }, supervisor: { drainTimeoutMs: 80 } });
  h.start();
  try {
    await h.wait(() => (h.status().lastResult as { status?: string })?.status === "deferred");
    await h.wait(() => h.events().some((event) => event.event === "resumed"));
    expect(h.events().some((event) => event.event === "shutdown")).toBe(false);
    expect(h.events().filter((event) => event.event === "start")).toHaveLength(1);
    expect(h.status().version).toBe("1.0.0");
  } finally { await h.stop(); }
});

it("immediately honors a persistent-kernel deferral and records its actionable reason", async () => {
  const reason = "kernel state is active; reset kernel to allow update";
  const h = harness({ current: { deferReason: reason }, supervisor: { drainTimeoutMs: 15_000 } });
  h.start();
  try {
    // Initial registration, artifact staging and both Node preflights precede drain.
    // Measure deferral from the worker receiving drain, not from fixture startup.
    let drainedWorker: Event | undefined;
    await h.wait(() => {
      drainedWorker = h.events().find((event) => event.version === "1.0.0" && event.event === "drain");
      return Boolean(drainedWorker);
    }, 12_000);
    expect(drainedWorker?.at).toBeTypeOf("number");
    let status: Record<string, unknown> = {};
    await h.wait(() => {
      status = h.status();
      return (status.lastResult as { status?: string })?.status === "deferred";
    }, 5_000);
    const deferralMs = Number(status.updatedAt) - Number(drainedWorker?.at);
    expect(deferralMs).toBeGreaterThanOrEqual(0);
    expect(deferralMs).toBeLessThan(5_000);
    expect(status).toMatchObject({ version: "1.0.0", phase: "running", lastResult: { status: "deferred", reason } });
    const events = h.events();
    expect(events.some((event) => event.event === "shutdown")).toBe(false);
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.pid).toBe(drainedWorker?.pid);
  } finally { await h.stop(); }
});

it("keeps an initially disconnected current worker alive rather than applying the candidate readiness deadline", async () => {
  const h = harness({ current: { ready: false }, supervisor: { readyTimeoutMs: 50 } });
  h.start();
  try {
    await h.wait(() => h.events().some((event) => event.event === "start"));
    await delay(300);
    expect(h.events().filter((event) => event.event === "start")).toHaveLength(1);
    expect(h.events().some((event) => event.event === "shutdown")).toBe(false);
    expect(h.artifactFetches()).toBe(0);
    expect(h.status().version).toBe("1.0.0");
  } finally { await h.stop(); }
});

it("recovers an interrupted pending activation to its verified predecessor", async () => {
  const h = harness();
  const rejectedEntry = join(h.root, "interrupted candidate.cjs");
  writeFileSync(rejectedEntry, h.candidate);
  mkdirSync(h.stateDir, { recursive: true });
  const from = { version: "1.0.0", sha256: hash(h.source), entryPoint: h.entryPoint };
  const candidate = { version: "1.1.0", sha256: hash(h.candidate), entryPoint: rejectedEntry };
  writeFileSync(join(h.stateDir, "state.json"), JSON.stringify({
    schemaVersion: 1, phase: "starting-candidate", current: from, pending: { from, candidate, startedAt: Date.now() }, updatedAt: Date.now()
  }));
  h.start();
  try {
    await h.wait(() => (h.status().lastResult as { status?: string })?.status === "cooldown");
    expect(h.status()).toMatchObject({ version: "1.0.0", failed: { version: "1.1.0" } });
    expect(h.status().pendingVersion).toBeUndefined();
    expect(h.events().filter((event) => event.event === "start").map((event) => event.version)).toEqual(["1.0.0"]);
  } finally { await h.stop(); }
});

it("ignores a downgrade and supports a local check request without changing the normal polling interval", async () => {
  const h = harness({ manifestVersion: "0.9.0" });
  h.start();
  try {
    await h.wait(() => (h.status().lastResult as { status?: string })?.status === "older-release-ignored");
    expect(h.artifactFetches()).toBe(0);
    h.setOffer("1.1.0");
    await requestUpdateCheck(h.stateDir);
    await h.wait(() => h.events().some((event) => event.event === "activated"));
    expect(h.status().version).toBe("1.1.0");
  } finally { await h.stop(); }
});


async function fullLauncherFixture(failNewSupervisor = false, holdCurrentManifest = false) {
  const root = temporaryDirectory();
  const stateDir = join(root, "controller state");
  const eventsFile = join(root, "controller events.jsonl");
  const releaseDir = join(root, "published releases");
  mkdirSync(releaseDir);
  writeFileSync(eventsFile, "");
  const updaterPath = fileURLToPath(new URL("../src/updater.ts", import.meta.url));
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
    const contents = [
      "import { runLauncher, runSupervisor } from " + JSON.stringify(updaterPath) + ";",
      'import { readFileSync, appendFileSync, existsSync } from "node:fs";',
      'import { join } from "node:path";',
      "const VERSION = " + JSON.stringify(version) + ";",
      'if (process.argv.includes("--version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      'const [eventsFile,stateDir,releaseDir] = process.argv.slice(2);',
      'if (process.env.MCP_RELAY_WORKER === "1") {',
      workerSource(version),
      '} else {',
      '  const isSupervisor = process.env.MCP_RELAY_SUPERVISOR === "1";',
      '  appendFileSync(eventsFile, JSON.stringify({version:VERSION,event:isSupervisor ? "supervisor-entry" : "launcher-entry",pid:process.pid,paused:false}) + "\\n");',
      '  if (isSupervisor && VERSION === "1.1.0" && ' + JSON.stringify(failNewSupervisor) + ') process.exit(52);',
      '  const fetcher = async (input, init = {}) => {',
      '    const url = new URL(String(input));',
      '    if (url.pathname.endsWith("stable.json")) {',
      '      const manifest = readFileSync(join(releaseDir,"manifest.json"),"utf8");',
      '      while (' + JSON.stringify(holdCurrentManifest) + ' && JSON.parse(manifest).version === VERSION && !existsSync(join(releaseDir,VERSION+".manifest-ready"))) {',
      '        if (init.signal?.aborted) throw new Error("fixture manifest check cancelled");',
      '        await new Promise((resolve) => setTimeout(resolve, 10));',
      '      }',
      '      return new Response(manifest);',
      '    }',
      '    return new Response(readFileSync(join(releaseDir,url.pathname.split("/").pop())));',
      '  };',
      '  const options = {entryPoint:process.argv[1],version:VERSION,args:process.argv.slice(2),relayUrl:"https://relay.example",stateDir,pollIntervalMs:60000,drainTimeoutMs:1000,readyTimeoutMs:2000,stabilityMs:80,log(message){process.stderr.write(message+"\\n");}};',
      '  (isSupervisor ? runSupervisor(options,{fetch:fetcher}) : runLauncher(options)).then((code)=>{process.exitCode=code;}).catch((error)=>{process.stderr.write(error.stack+"\\n");process.exitCode=2;});',
      '}'
    ].join("\n");
    await build({
      stdin: { contents, resolveDir: dirname(updaterPath), sourcefile: "controller-fixture.ts", loader: "ts" },
      outfile: join(releaseDir, version + ".cjs"), platform: "node",
      format: "cjs", bundle: true, target: "node22", logLevel: "silent"
    });
  }
  const offer = (version: string) => {
    const bytes = readFileSync(join(releaseDir, version + ".cjs"));
    writeFileSync(join(releaseDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, version, url: "/artifacts/" + version + ".cjs",
      sha256: createHash("sha256").update(bytes).digest("hex"), minNodeVersion: "22.5.0"
    }));
  };
  offer("1.1.0");
  const child = spawn(process.execPath, [join(releaseDir, "1.0.0.cjs"), eventsFile, stateDir, releaseDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MCP_RELAY_LAUNCHED: "0", MCP_RELAY_SUPERVISOR: "0", MCP_RELAY_WORKER: "0", MCP_RELAY_START_DRAINED: "0" }
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-6000); });
  child.stderr.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-6000); });
  let exited = false;
  const completion = new Promise<void>((done) => child.once("exit", () => { exited = true; done(); }));
  const events = (): Event[] => readFileSync(eventsFile, "utf8").split("\n").flatMap((line) => {
    try { return line ? [JSON.parse(line) as Event] : []; } catch { return []; }
  });
  return {
    stateDir, events, offer, status: () => readUpdateStatus(stateDir),
    releaseManifestCheck(version: string) { writeFileSync(join(releaseDir, version + ".manifest-ready"), "ready"); },
    async wait(predicate: () => boolean, timeout = 12_000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (exited) throw new Error("launcher exited unexpectedly: " + logs);
        if (predicate()) return;
        await delay(25);
      }
      throw new Error("launcher fixture timed out: " + JSON.stringify(readUpdateStatus(stateDir)) + "\n" + logs);
    },
    livePids() {
      return [...new Set(events().map((event) => event.pid))].filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
    },
    async stop() {
      if (!exited) child.kill("SIGTERM");
      const end = Date.now() + 10_000;
      while (!exited && Date.now() < end) await delay(25);
      if (!exited) {
        child.kill("SIGKILL");
        await completion;
        throw new Error("launcher did not shut down cleanly: " + logs);
      }
      await completion;
    }
  };
}

it("hands off the complete supervisor A to B to C without accumulating parent processes", async () => {
  const h = await fullLauncherFixture(false, true);
  const waitForActiveStatus = async (version: string, phase: "checking" | "running") => {
    let snapshot: Record<string, unknown> = {};
    await h.wait(() => {
      snapshot = h.status();
      return snapshot.version === version && snapshot.supervisorVersion === version && snapshot.phase === phase
        && (phase !== "running" || (snapshot.lastResult as { status?: string })?.status === "current")
        && h.events().some((event) => event.version === version && event.event === "activated");
    });
    return snapshot;
  };
  try {
    // A new supervisor immediately checks its manifest after activation. Hold that
    // response so the former activated-then-read assertion race is deterministic.
    await waitForActiveStatus("1.1.0", "checking");
    h.releaseManifestCheck("1.1.0");
    const b = await waitForActiveStatus("1.1.0", "running");
    expect(b).toMatchObject({ version: "1.1.0", supervisorVersion: "1.1.0", phase: "running" });
    expect(h.events().filter((event) => event.event === "launcher-entry")).toHaveLength(1);
    expect(h.events().some((event) => event.version === "1.1.0" && event.event === "supervisor-entry")).toBe(true);
    expect(h.livePids()).toHaveLength(3);
    h.offer("1.2.0");
    await requestUpdateCheck(h.stateDir);
    await waitForActiveStatus("1.2.0", "checking");
    h.releaseManifestCheck("1.2.0");
    const c = await waitForActiveStatus("1.2.0", "running");
    expect(c).toMatchObject({ version: "1.2.0", supervisorVersion: "1.2.0", previousVersion: "1.1.0", phase: "running" });
    expect(h.events().filter((event) => event.event === "launcher-entry")).toHaveLength(1);
    expect(h.livePids()).toHaveLength(3);
  } finally { await h.stop(); }
}, 30_000);

it("rolls back the whole controller when a healthy candidate worker has a broken supervisor entry", async () => {
  const h = await fullLauncherFixture(true);
  try {
    await h.wait(() => h.status().version === "1.0.0"
      && Boolean(h.status().failed)
      && h.events().filter((event) => event.version === "1.0.0" && event.event === "supervisor-entry").length === 2);
    await h.wait(() => h.events().filter((event) => event.version === "1.0.0" && event.event === "start").length === 2);
    expect(h.status()).toMatchObject({ version: "1.0.0", failed: { version: "1.1.0" } });
    expect(h.events().some((event) => event.version === "1.1.0" && event.event === "activated")).toBe(false);
    expect(h.livePids()).toHaveLength(3);
  } finally { await h.stop(); }
}, 25_000);


it("clears a corrupt handoff when recovering a verified predecessor, even while the network is unavailable", async () => {
  const h = harness({ current: { ready: false }, supervisor: { readyTimeoutMs: 80 } });
  const rejectedEntry = join(h.root, "corrupt current.cjs");
  writeFileSync(rejectedEntry, "corrupt\n" + h.candidate);
  mkdirSync(h.stateDir, { recursive: true });
  const previous = { version: "1.0.0", sha256: hash(h.source), entryPoint: h.entryPoint };
  const candidate = { version: "1.1.0", sha256: hash(h.candidate), entryPoint: rejectedEntry };
  writeFileSync(join(h.stateDir, "state.json"), JSON.stringify({
    schemaVersion: 1, phase: "handoff", current: candidate, previous,
    handoff: { from: previous, candidate, startedAt: Date.now() }, updatedAt: Date.now()
  }));
  h.start();
  try {
    await h.wait(() => h.events().some((event) => event.event === "start"));
    await delay(250);
    expect(h.status()).toMatchObject({ version: "1.0.0", failed: { version: "1.1.0" } });
    expect(h.status().pendingVersion).toBeUndefined();
    expect(h.events().filter((event) => event.event === "start")).toHaveLength(1);
    expect(h.events().find((event) => event.event === "start")?.paused).toBe(false);
    expect(h.events().some((event) => event.event === "shutdown")).toBe(false);
  } finally { await h.stop(); }
});

it("does not disguise invalid state-directory errors as lock contention", async () => {
  const root = temporaryDirectory();
  const file = join(root, "not-a-directory");
  writeFileSync(file, "occupied");
  try {
    await acquireUpdateLock(file);
    throw new Error("expected the invalid directory to fail");
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBeTruthy();
    expect((error as NodeJS.ErrnoException).code).not.toBe("UPDATE_LOCK_BUSY");
  }
});