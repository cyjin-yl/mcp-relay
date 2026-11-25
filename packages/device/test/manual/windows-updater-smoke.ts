/**
 * Offline, self-contained native OTA acceptance.
 * Build with: node scripts/build-windows-updater-tests.mjs
 * Run with: node --test <windows-updater-smoke.cjs>
 * Fixtures use the real updater, fake HTTPS responses and isolated TEMP state.
 * They never pair a device, read real credentials or change the installed relay.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { readUpdateStatus, requestUpdateCheck } from "../../src/updater.js";

declare const RELAY_UPDATER_FIXTURES: Record<string, string>;
interface Event { version: string; event: string; pid: number; parentPid: number; paused: boolean }
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function fixture(mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "relay OTA 更新 space-"));
  const stateDir = join(root, "controller state");
  const releaseDir = join(root, "published releases");
  const eventsFile = join(root, "events.jsonl");
  mkdirSync(releaseDir);
  writeFileSync(eventsFile, "");
  for (const [version, source] of Object.entries(RELAY_UPDATER_FIXTURES)) {
    writeFileSync(join(releaseDir, version + ".cjs"), source);
  }
  function offer(version: string, badHash = false) {
    const bytes = readFileSync(join(releaseDir, version + ".cjs"));
    writeFileSync(join(releaseDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, version, url: "/artifacts/" + version + ".cjs",
      sha256: badHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
      minNodeVersion: "22.5.0"
    }));
  }
  offer("1.1.0", mode === "bad-sha");
  const child = fork(join(releaseDir, "1.0.0.cjs"), [eventsFile, stateDir, releaseDir, mode], {
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, MCP_RELAY_LAUNCHED: "0", MCP_RELAY_SUPERVISOR: "0",
      MCP_RELAY_WORKER: "0", MCP_RELAY_START_DRAINED: "0" }
  });
  let logs = "", exited = false, failure: Error | undefined;
  child.stdout?.on("data", chunk => { logs += String(chunk); });
  child.stderr?.on("data", chunk => { logs += String(chunk); });
  child.on("error", error => { failure = error; });
  const completion = new Promise<number | null>(done => child.once("exit", code => { exited = true; done(code); }));
  const events = (): Event[] => readFileSync(eventsFile, "utf8").split("\n").flatMap(line => {
    try { return line ? [JSON.parse(line) as Event] : []; } catch { return []; }
  });
  const livePids = () => [...new Set(events().map(event => event.pid))].filter(live);
  return {
    root, stateDir, offer, events, livePids, status: () => readUpdateStatus(stateDir),
    async wait(predicate: () => boolean, timeout = 25_000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (failure) throw failure;
        if (exited) throw new Error("fixture launcher exited: " + logs);
        if (predicate()) return;
        await delay(25);
      }
      throw new Error("fixture timed out: " + JSON.stringify(readUpdateStatus(stateDir)) + "\n" + logs);
    },
    async stop() {
      if (!exited && child.connected) child.send({ type: "fixture:stop" });
      const end = Date.now() + 10_000;
      while (!exited && Date.now() < end) await delay(25);
      const clean = exited;
      if (!exited) child.kill("SIGKILL");
      const code = await completion;
      // Preserve diagnostics even on failure. TEMP evidence is never deleted.
      writeFileSync(join(root, "controller.log"), logs);
      writeFileSync(join(root, "final-status.json"), JSON.stringify(readUpdateStatus(stateDir), null, 2) + "\n");
      assert.ok(clean, "fixture launcher failed graceful shutdown: " + logs);
      assert.equal(code, 0, "fixture launcher exit code");
      const workerEnd = Date.now() + 5_000;
      while (livePids().length && Date.now() < workerEnd) await delay(25);
      assert.deepEqual(livePids(), [], "fixture left processes alive");
    }
  };
}

test("native OTA hands off supervisor and worker A -> B -> C with one launcher", { timeout: 60_000 }, async t => {
  const h = fixture();
  t.diagnostic("evidence: " + h.root);
  const active = async (version: string) => {
    await h.wait(() => {
      const status = h.status();
      return status.version === version && status.supervisorVersion === version && status.phase === "running"
        && (status.lastResult as { status?: string })?.status === "current"
        && h.events().some(event => event.version === version && event.event === "activated");
    });
    await h.wait(() => h.livePids().length === 3);
    assert.equal(h.events().filter(event => event.event === "launcher-entry").length, 1);
    assert.equal(h.livePids().length, 3);
  };
  try {
    await active("1.1.0");
    const firstEvents = h.events();
    const flushed = firstEvents.findIndex(event => event.version === "1.0.0" && event.event === "result-flushed");
    const stopped = firstEvents.findIndex(event => event.version === "1.0.0" && event.event === "shutdown");
    const started = firstEvents.findIndex(event => event.version === "1.1.0" && event.event === "worker-start");
    assert.ok(flushed >= 0 && stopped > flushed && started > stopped, "drain must finish before replacement");
    assert.equal(firstEvents[started]!.paused, true);
    h.offer("1.2.0");
    await requestUpdateCheck(h.stateDir);
    await active("1.2.0");
    assert.equal(h.status().previousVersion, "1.1.0");
    assert.equal(h.events().filter(event => event.event === "supervisor-entry").length, 3);
  } finally { await h.stop(); }
});

test("native OTA restores the whole controller after a broken new supervisor", { timeout: 45_000 }, async t => {
  const h = fixture("broken-supervisor");
  t.diagnostic("evidence: " + h.root);
  try {
    await h.wait(() => h.status().version === "1.0.0" && Boolean(h.status().failed)
      && h.events().filter(event => event.version === "1.0.0" && event.event === "worker-start").length === 2
      && h.livePids().length === 3);
    assert.equal((h.status().failed as { version: string }).version, "1.1.0");
    assert.ok(!h.events().some(event => event.version === "1.1.0" && event.event === "activated"));
    assert.equal(h.events().filter(event => event.event === "launcher-entry").length, 1);
    assert.equal(h.events().filter(event => event.version === "1.0.0" && event.event === "supervisor-entry").length, 2);
  } finally { await h.stop(); }
});

test("native OTA rejects a bad digest before draining the current worker", { timeout: 35_000 }, async t => {
  const h = fixture("bad-sha");
  t.diagnostic("evidence: " + h.root);
  try {
    await h.wait(() => Boolean(h.status().failed));
    assert.equal(h.status().version, "1.0.0");
    assert.match(String((h.status().failed as { reason: string }).reason), /SHA-256 mismatch/);
    assert.equal(h.events().filter(event => event.event === "worker-start").length, 1);
    assert.ok(!h.events().some(event => event.event === "drain"));
  } finally { await h.stop(); }
});

test("native OTA preserves active work when a worker defers drain", { timeout: 35_000 }, async t => {
  const h = fixture("deferred");
  t.diagnostic("evidence: " + h.root);
  try {
    await h.wait(() => (h.status().lastResult as { status?: string })?.status === "deferred"
      && h.events().some(event => event.event === "resumed"));
    assert.equal(h.status().version, "1.0.0");
    assert.equal((h.status().lastResult as { reason: string }).reason, "fixture work is active");
    assert.equal(h.events().filter(event => event.event === "worker-start").length, 1);
    assert.ok(!h.events().some(event => event.event === "shutdown"));
  } finally { await h.stop(); }
});
