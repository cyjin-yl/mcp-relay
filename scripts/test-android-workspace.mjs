import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
const directory = process.env.RELAY_WORKSPACE_SMOKE_DIRECTORY || join(homedir(), ".mcp-relay", "workspace-smoke");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const jar = process.argv[2];
assert.ok(jar && /^\/[A-Za-z0-9_./-]+\.jar$/.test(jar), "Usage: node test-android-workspace.mjs /absolute/helper.jar [eof expiry recovery node_exit helper_kill fence heartbeat hard]");
const modes = process.argv.slice(3);
if (!modes.length) modes.push("pre_fence", "eof", "expiry", "recovery", "node_exit", "helper_kill", "fence", "heartbeat", "hard");
const helperSha256 = createHash("sha256").update(readFileSync(jar)).digest("hex");
const allowedModes = new Set(["pre_fence", "eof", "expiry", "recovery", "node_exit", "helper_kill", "fence", "heartbeat", "hard"]);
assert.ok(modes.every(mode => allowedModes.has(mode)), "Unknown acceptance case");
const probePackage = "dev.cyjin.mcprelay.workspaceprobe";
const run = command => execFileSync("su", ["-c", command], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
const probeDataDirectory = run("/system/bin/dumpsys package " + probePackage).match(/dataDir=(\S+)/)?.[1];
assert.ok(probeDataDirectory?.endsWith("/" + probePackage) && /^[/A-Za-z0-9_.-]+$/.test(probeDataDirectory));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = () => {
  const windows = run("/system/bin/dumpsys window");
  return {
    topFocusedDisplayId: windows.match(/mTopFocusedDisplayId=(\d+)/)?.[1] ?? null,
    selectedIme: run("/system/bin/settings get secure default_input_method").trim(),
    enabledImes: run("/system/bin/settings get secure enabled_input_methods").trim(),
    displays: [...run("/system/bin/cmd display get-displays").matchAll(/Display id (\d+):/g)].map(value => value[1]).sort(),
  };
};
const results = [];
async function test(mode) {
  run("/system/bin/am force-stop " + probePackage); // Only this test's private probe package.
  const before = snapshot();
  assert.notEqual(before.topFocusedDisplayId, null);
  const leaseId = "smoke_" + randomUUID().replaceAll("-", "");
  const instanceId = randomUUID().replaceAll("-", "");
  const journal = join(directory, instanceId);
  mkdirSync(journal, { mode: 0o700 });
  const receipt = journal + "/android-" + instanceId + ".json";
  const revocationPath = journal + "/revoked.json";
  const helperCommand = "CLASSPATH='" + jar + "' /system/bin/app_process / dev.cyjin.mcprelay.workspace.WorkspaceMain --owner " + leaseId + " " + instanceId;
  const ownerProgram = "import {spawn} from 'node:child_process'; const child=spawn('su',['-c'," + JSON.stringify(helperCommand) + "],{stdio:['pipe','pipe','pipe']}); process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on('exit',code=>process.exit(code??1));";
  const child = mode === "node_exit"
    ? spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn("su", ["-c", helperCommand], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = []; let stderr = "", buffer = "", exited = false;
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { messages.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.on("exit", () => { exited = true; });
  child.stdin.on("error", () => {});
  const waiting = async (predicate, timeout = 10000) => {
    const until = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= until) throw new Error("Timed out; messages=" + JSON.stringify(messages.map(({ event, id, ok, error }) => ({ event, id, ok, error }))));
      await pause(25);
    }
  };
  let sequence = 0;
  const request = async (op, args = {}) => {
    const id = "request_" + ++sequence;
    child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    await waiting(() => messages.some(value => value.id === id) || exited);
    const response = messages.find(value => value.id === id);
    assert.equal(response?.ok, true, JSON.stringify(response));
    return response.result;
  };
  const report = { mode, leaseId, instanceId, helperSha256, before };
  try {
    if (mode === "pre_fence") writeFileSync(revocationPath, JSON.stringify({ schema: 1, leaseId, reason: "pre_fenced", revokedAt: Date.now() }), { mode: 0o600 });
    child.stdin.write(JSON.stringify({ leaseId, instanceId, width: 640, height: 480, ttlMs: mode === "hard" ? 14000 : 30000, hardTtlMs: mode === "hard" ? 16000 : 45000, receipt, revocationPath }) + "\n");
    await waiting(() => messages.some(value => value.event === "ready") || messages.some(value => value.ok === false));
    const ready = messages.find(value => value.event === "ready");
    if (mode === "pre_fence") {
      assert.equal(ready, undefined);
      await waiting(() => exited);
      const saved = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(saved.displayId, -1);
      assert.equal(saved.result.ownedDisplayRemoved, true);
      report.receipt = saved;
      report.after = snapshot();
      assert.deepEqual(report.after, before);
      report.passed = true;
      return;
    }
    assert.ok(ready, JSON.stringify(messages.map(({ event, id, ok, error }) => ({ event, id, ok, error }))));
    report.ready = ready;
    assert.equal(ready.display.removeMode, 0);
    assert.equal(ready.display.flags & 6272, 6272); // TRUSTED + OWN_FOCUS + STEAL_TOP_FOCUS_DISABLED.
    report.launch = await request("launch", { component: probePackage + "/.ProbeActivity" });
    await pause(300);
    const started = snapshot();
    assert.equal(started.topFocusedDisplayId, before.topFocusedDisplayId);
    assert.equal(started.selectedIme, before.selectedIme);
    assert.equal(started.enabledImes, before.enabledImes);
    report.afterLaunch = started;
    await request("act", { action: { type: "text", text: "Relay42" } });
    await request("act", { action: { type: "click", x: 300, y: 245 } });
    await pause(100);
    const state = JSON.parse(run("/system/bin/cat " + probeDataDirectory + "/files/probe.json"));
    assert.equal(state.displayId, ready.display.id);
    assert.equal(state.text, "Relay42");
    assert.equal(state.clicks, 1);
    report.privateInput = state;
    const screenshot = await request("capture");
    const png = Buffer.from(screenshot.base64, "base64");
    assert.equal(png.readUInt32BE(16), 640); assert.equal(png.readUInt32BE(20), 480);
    report.capture = { bytes: png.length, width: 640, height: 480, displayId: screenshot.displayId };
    writeFileSync(directory + "/private-" + instanceId + ".png", png);
    const during = snapshot();
    assert.equal(during.topFocusedDisplayId, before.topFocusedDisplayId);
    assert.equal(during.selectedIme, before.selectedIme); assert.equal(during.enabledImes, before.enabledImes);
    report.during = during;
    const drag = request("act", { action: { type: "drag", fromX: 500, fromY: 400, toX: 500, toY: 420, durationMs: 2500 } });
    await pause(75);
    const heartbeatStarted = Date.now();
    await request("renew", { ttlMs: 30000 });
    report.heartbeatDuringDragMs = Date.now() - heartbeatStarted;
    assert.ok(report.heartbeatDuringDragMs < 1000, "Native heartbeat was blocked by a gesture");
    await drag;
    if (mode === "node_exit" || mode === "helper_kill") {
      child.stdin.write(JSON.stringify({ id: "interrupted_drag", op: "act", action: { type: "drag", fromX: 500, fromY: 400, toX: 500, toY: 430, durationMs: 5000 } }) + "\n");
      await pause(150);
      report.terminatedDuringGesture = true;
    }
    if (mode === "expiry") await request("renew", { ttlMs: 600 });
    else if (mode === "fence") writeFileSync(revocationPath, JSON.stringify({ schema: 1, leaseId, reason: "smoke", revokedAt: Date.now() }), { mode: 0o600 });
    else if (mode === "heartbeat" || mode === "hard") report.finalRenewal = await request("renew", { ttlMs: 30000 });
    else if (mode === "node_exit") child.kill("SIGKILL"); // Only the test's explicitly-created Node owner.
    else if (mode === "helper_kill") {
      const owned = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(owned.pid, ready.pid);
      const stat = run("/system/bin/cat /proc/" + ready.pid + "/stat");
      assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], owned.processStartTicks);
      const cmdline = run("/system/bin/cat /proc/" + ready.pid + "/cmdline");
      assert.ok(cmdline.endsWith("dev.cyjin.mcprelay.workspace.WorkspaceMain\0--owner\0" + leaseId + "\0" + instanceId + "\0"));
      run("/system/bin/kill -9 " + ready.pid); // Identity-verified test helper only.
    } else if (mode === "recovery") {
      const owned = JSON.parse(readFileSync(receipt, "utf8"));
      const unrelated = "other_" + randomUUID().replaceAll("-", "");
      const unrelatedPath = journal + "/android-" + unrelated + ".json";
      writeFileSync(unrelatedPath, JSON.stringify({ ...owned, instanceId: unrelated, displayName: "mcp-relay-workspace:" + leaseId + ":" + unrelated }));
      const guarded = JSON.parse(run("CLASSPATH='" + jar + "' /system/bin/app_process / dev.cyjin.mcprelay.workspace.WorkspaceMain --recover '" + unrelatedPath + "'").trim());
      assert.equal(guarded.matchedOwnerProcess, false);
      await request("inspect");
      report.foreignReceiptIgnored = true;
      report.nativeRecovery = JSON.parse(run("CLASSPATH='" + jar + "' /system/bin/app_process / dev.cyjin.mcprelay.workspace.WorkspaceMain --recover '" + receipt + "'").trim());
      assert.equal(report.nativeRecovery.matchedOwnerProcess, true);
      assert.equal(report.nativeRecovery.complete, true);
    } else child.stdin.end();
    await waiting(() => exited, 25000);
    if (mode !== "helper_kill") await waiting(() => JSON.parse(readFileSync(receipt, "utf8")).phase === "closed");
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    if (mode === "helper_kill") saved.result = JSON.parse(run("CLASSPATH='" + jar + "' /system/bin/app_process / dev.cyjin.mcprelay.workspace.WorkspaceMain --recover '" + receipt + "'").trim());
    report.receipt = saved;
    assert.equal(saved.result.ownedDisplayRemoved, true);
    assert.equal(saved.result.inputRevoked, true);
    if (mode !== "helper_kill") assert.ok(saved.result.movedRootTasks.length >= 1);
    if (mode === "heartbeat") assert.equal(saved.result.reason, "owner_heartbeat_lost");
    if (mode === "fence") assert.equal(saved.result.reason, "revoked");
    if (mode === "hard") { assert.equal(saved.result.reason, "lease_expired"); assert.ok(report.finalRenewal.remainingMs < 16000); }
    const name = "mcp-relay-workspace:" + leaseId + ":" + instanceId;
    const found = JSON.parse(run("CLASSPATH='" + jar + "' /system/bin/app_process / dev.cyjin.mcprelay.workspace.WorkspaceMain --find '" + name + "'").trim());
    assert.deepEqual(found.displays, []);
    await pause(150);
    const migrated = JSON.parse(run("/system/bin/cat " + probeDataDirectory + "/files/probe.json"));
    assert.equal(migrated.displayId, 0);
    assert.equal(migrated.taskId, state.taskId);
    assert.equal(migrated.text, "Relay42");
    report.migrated = migrated;
    report.after = snapshot();
    assert.deepEqual(report.after.displays, before.displays);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    child.stdin.end();
    await pause(100);
    report.stderr = stderr;
    report.messages = messages.map(value => value.result?.base64 ? { ...value, result: { ...value.result, base64: "<private PNG saved separately>" } } : value);
    writeFileSync(directory + "/activity-" + mode + "-" + instanceId + ".json", JSON.stringify(report, null, 2));
    results.push(report);
    run("/system/bin/am force-stop " + probePackage);
  }
}
try {
  for (const mode of modes) await test(mode);
  console.log(JSON.stringify({ helperSha256, passed: results.length, cases: results.map(({ mode, ready, privateInput, capture, receipt, migrated, passed, heartbeatDuringDragMs, foreignReceiptIgnored, nativeRecovery }) => ({ mode, heartbeatDuringDragMs, foreignReceiptIgnored, nativeRecovery, displayId: ready?.display.id, privateInput, capture, cleanup: receipt?.result, migrated, passed })) }, null, 2));
} catch (error) {
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = 1;
}
