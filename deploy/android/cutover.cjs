#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const stamp = () => new Date().toISOString();
const env = JSON.parse(fs.readFileSync(plan.environmentFile, "utf8"));
const report = { schemaVersion: 1, runId: plan.runId, passed: false, phase: "scheduled", startedAt: stamp(),
  configSha256: plan.configSha256, originalScriptSha256: plan.originalScriptSha256,
  bootstrapSha256: plan.bootstrapSha256, expectedSha256: plan.expectedSha256 };
let oldTouched = false, scriptReplaced = false, newStarted = false;
let newPane;
const tracked = new Map();
function save() {
  report.updatedAt = stamp();
  const temporary = plan.receipt + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, plan.receipt);
}
function phase(value) { report.phase = value; save(); }
function info(pid) {
  try {
    const base = "/proc/" + pid;
    const stat = fs.readFileSync(base + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), start: fields[19],
      exe: fs.readlinkSync(base + "/exe"), args: fs.readFileSync(base + "/cmdline").toString().split("\0").filter(Boolean) };
  } catch { return null; }
}
function sameIdentity(current, expected) {
  return Boolean(current && expected && current.state !== "Z" && current.pid === expected.pid
    && current.start === expected.start && current.exe === expected.exe
    && JSON.stringify(current.args) === JSON.stringify(expected.args));
}
function same(expected) {
  return Boolean(expected && sameIdentity(info(expected.pid), expected));
}
function allProcesses() {
  const values = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    const value = info(pid);
    if (value && value.state !== "Z") values.push(value);
  }
  return values;
}
function configArgument(item) {
  const index = item.args.indexOf("--config");
  return index >= 0 ? item.args[index + 1] : undefined;
}
function matchingRelays() {
  return allProcesses().filter((item) => item.exe === plan.node && item.args.includes("connect")
    && configArgument(item) === plan.config);
}
function exactSignal(expected, signal = "SIGTERM") {
  if (same(expected)) process.kill(expected.pid, signal);
}
async function until(predicate, ms, label) {
  const stop = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= stop) throw new Error("Timed out: " + label);
    await delay(250);
  }
}
function run(binary, args, timeout = 15000) {
  const result = cp.spawnSync(binary, args, { env, cwd: plan.root, encoding: "utf8", timeout, maxBuffer: 256 * 1024 });
  if (result.status !== 0) throw new Error(path.basename(binary) + " command failed: " +
    (result.error?.message || result.stderr || "exit " + result.status).trim().slice(0, 500));
  return result.stdout.trim();
}
function currentPanes() {
  const result = cp.spawnSync(plan.tmux, ["list-panes", "-t", plan.session, "-F", "#{session_name}\t#{pane_pid}\t#{pane_id}"],
    { env, cwd: plan.root, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [session, pid, pane] = line.split("\t"); return { session, pid: Number(pid), pane };
  });
}
function copyPreserved(source, destination, expected, mode = 0o600) {
  if (digest(source) !== expected) throw new Error("Source digest changed: " + path.basename(source));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    if (digest(destination) !== expected) throw new Error("Existing artifact conflicts: " + path.basename(destination));
    return;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, mode);
  if (digest(destination) !== expected) throw new Error("Copied artifact failed integrity check");
}
function replaceScript(source, expected) {
  if (digest(source) !== expected) throw new Error("Saved script digest changed");
  const temporary = plan.liveScript + ".ota-" + crypto.randomUUID();
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, plan.scriptMode);
  fs.renameSync(temporary, plan.liveScript);
  if (digest(plan.liveScript) !== expected) throw new Error("Atomic script replacement digest mismatch");
}
function shQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function launchSession() {
  if (currentPanes().length) throw new Error("Existing tmux session still owns a pane; no duplicate launcher started");
  const command = "exec " + shQuote(plan.node) + " " + shQuote(plan.environmentRunner) + " " + shQuote(plan.planFile);
  run(plan.tmux, ["new-session", "-d", "-s", plan.session, command]);
}
function snapshotNew() {
  const rows = allProcesses();
  const root = newPane && rows.find((item) => item.pid === newPane.pid);
  // A reused pane PID must never become a new ownership root or replace its saved identity.
  if (!sameIdentity(root, newPane) || !same(newPane)) {
    const current = newPane ? info(newPane.pid) : null;
    report.paneIdentityFailure = { expectedPid: newPane?.pid ?? null, expectedStart: newPane?.start ?? null,
      observedStart: current?.start ?? null, observedState: current?.state ?? null,
      executableMatches: Boolean(current && newPane && current.exe === newPane.exe),
      argumentsMatch: Boolean(current && newPane && JSON.stringify(current.args) === JSON.stringify(newPane.args)),
      checkedAt: stamp() };
    save();
    throw new Error("Managed pane identity changed or disappeared; rollback deferred without stopping processes");
  }
  const owned = new Set([newPane.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of rows) if (owned.has(item.ppid) && !owned.has(item.pid)) {
      owned.add(item.pid); changed = true;
    }
  }
  const own = rows.filter((item) => owned.has(item.pid));
  for (const item of own) tracked.set(item.pid, item.pid === newPane.pid ? newPane : item);
  return own;
}
function ownedRole(item) {
  if (item.pid === newPane?.pid) return sameIdentity(item, newPane) ? "environment-runner" : null;
  if (item.exe === plan.bash && item.args[1] === plan.liveScript) return "launcher-loop";
  if (item.exe === plan.node && item.args.includes("connect") && configArgument(item) === plan.config
      && (item.args[1] === plan.bootstrapDestination
          || (item.args[1]?.startsWith(path.dirname(plan.config) + "/updates/") && item.args[1].endsWith("/cli.cjs"))))
    return "managed-relay";
  if (item.args[0] === "tee" && item.args[1] === "-a" && item.args[2] === path.join(path.dirname(plan.config), "relay.log"))
    return "logger";
  const parent = info(item.ppid);
  if (item.args[0] === "sleep" && item.args[1] === "3" && item.args.length === 2
      && parent?.exe === plan.bash && parent.args[1] === plan.liveScript) return "restart-delay";
  return null;
}
function readStatus() {
  try { return JSON.parse(run(plan.node, [plan.bootstrapDestination, "update-status", "--config", plan.config], 8000)); }
  catch { return null; }
}
async function fetchBytes(url, limit) {
  if (new URL(url).origin !== new URL(plan.manifestUrl).origin) throw new Error("Release origin mismatch");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (response.status !== 200) throw new Error("Release HTTP status " + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Release response exceeds bound");
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), cacheControl: response.headers.get("cache-control") };
}
async function verifyFeed() {
  const manifestResponse = await fetchBytes(plan.manifestUrl, 65536);
  const manifest = JSON.parse(manifestResponse.bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.version !== plan.expectedVersion || manifest.sha256 !== plan.expectedSha256)
    throw new Error("Stable manifest has not promoted this exact candidate");
  const artifact = await fetchBytes(manifest.url, 2 * 1024 * 1024);
  const hash = crypto.createHash("sha256").update(artifact.bytes).digest("hex");
  if (hash !== plan.expectedSha256) throw new Error("Public release SHA-256 mismatch");
  const saved = path.join(plan.runDir, "verified-stable-cli.cjs");
  fs.writeFileSync(saved, artifact.bytes, { flag: "wx", mode: 0o600 });
  report.publicRelease = { version: manifest.version, sha256: hash, bytes: artifact.bytes.length,
    cacheControl: manifestResponse.cacheControl, checkedAt: stamp() };
}
function nodeEnvironment(pid) {
  const result = {};
  for (const entry of fs.readFileSync("/proc/" + pid + "/environ").toString().split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) result[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return result;
}
function verifyEnvironment() {
  const workers = matchingRelays().filter((item) => {
    try { return nodeEnvironment(item.pid).MCP_RELAY_WORKER === "1"; } catch { return false; }
  });
  if (workers.length !== 1) throw new Error("Did not observe exactly one managed worker for the original config");
  const next = nodeEnvironment(workers[0].pid);
  const keys = ["PREFIX", "HOME", "MCP_RELAY_BASH", "ANDROID_DATA", "ANDROID_ROOT", "ANDROID_RUNTIME_ROOT",
    "ANDROID_ART_ROOT", "ANDROID_I18N_ROOT", "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH", "DEX2OATBOOTCLASSPATH"];
  for (const key of keys) if (env[key] !== undefined && next[key] !== env[key])
    throw new Error("Required preserved environment differs: " + key);
  if (!next.PATH?.startsWith(env.PREFIX + "/bin:")) throw new Error("Termux PATH prefix was not preserved");
  report.environment = { verified: true, keys: keys.filter((key) => env[key] !== undefined),
    sourceSha256: digest(plan.environmentFile) };
  report.worker = { pid: workers[0].pid, start: workers[0].start, entrySha256: digest(workers[0].args[1]) };
}
async function rollback() {
  report.phase = "rollback"; save();
  if (newStarted) {
    const own = snapshotNew();
    const relays = matchingRelays();
    for (const item of relays) tracked.set(item.pid, item);
    const activeChildren = own.filter((item) => !ownedRole(item));
    if (activeChildren.length) throw new Error("Unrecognized managed descendants may be active work; rollback deferred without stopping them");
    if (relays.some((item) => ownedRole(item) !== "managed-relay"))
      throw new Error("An unrecognized relay owns the config; rollback deferred without stopping it");
    // Stop the exact tmux runner/loop and known relay generations, never user tool descendants.
    const targets = [...tracked.values()].filter((item) =>
      ["environment-runner", "launcher-loop", "managed-relay"].includes(ownedRole(item)));
    for (const item of targets) exactSignal(item);
    await until(() => targets.every((item) => !same(item)) && matchingRelays().length === 0,
      20000, "owned managed relay exit before restoring legacy");
    await until(() => currentPanes().length === 0, 10000, "owned tmux pane exit");
  }
  if (digest(plan.config) !== plan.configSha256) throw new Error("Config changed; no credentials were overwritten");
  if (scriptReplaced) replaceScript(plan.originalBackup, plan.originalScriptSha256);
  if (digest(plan.liveScript) !== plan.originalScriptSha256) throw new Error("Original launcher restoration failed");
  if (matchingRelays().length) throw new Error("A relay still owns the config; no duplicate legacy process started");
  if (digest(plan.oldWorker.args[1]) !== plan.legacyEntrySha256) throw new Error("Preserved legacy entry changed; rollback stopped");
  launchSession();
  await until(() => matchingRelays().some((item) => item.args[1] === plan.oldWorker.args[1]),
    15000, "restored legacy worker startup");
  const legacy = matchingRelays().find((item) => item.args[1] === plan.oldWorker.args[1]);
  report.rollback = { passed: true, phase: "restored", scriptSha256: digest(plan.liveScript),
    workerPid: legacy.pid, workerStart: legacy.start };
}
async function main() {
  await delay(Math.max(0, Date.parse(plan.notBefore) - Date.now()));
  const scheduled = JSON.parse(fs.readFileSync(plan.scheduledReceipt, "utf8"));
  if (scheduled.jobPid !== process.pid || scheduled.phase !== "scheduled")
    throw new Error("The durable scheduling receipt does not authorize this exact process");
  phase("preflight");
  if (digest(plan.environmentFile) !== plan.environmentSha256) throw new Error("Preserved environment digest changed");
  if (digest(plan.oldWorker.args[1]) !== plan.legacyEntrySha256) throw new Error("Preserved legacy entry changed");
  if (!same(plan.oldLauncher) || !same(plan.oldWorker)) throw new Error("Original PID/start-time/executable/argv changed");
  if (digest(plan.liveScript) !== plan.originalScriptSha256 || digest(plan.originalBackup) !== plan.originalScriptSha256
      || digest(plan.updatedScript) !== plan.updatedScriptSha256 || digest(plan.bootstrapSource) !== plan.bootstrapSha256
      || digest(plan.config) !== plan.configSha256) throw new Error("Preflight integrity mismatch");
  if (matchingRelays().length !== 1 || matchingRelays()[0].pid !== plan.oldWorker.pid)
    throw new Error("Another relay already owns the config before handoff");
  const panes = currentPanes();
  if (panes.length !== 1 || panes[0].session !== plan.session || panes[0].pid !== plan.oldLauncher.pid)
    throw new Error("The verified launcher is no longer the only pane in its tmux session");
  if (!env.PREFIX || !env.ANDROID_DATA || !env.BOOTCLASSPATH) throw new Error("Saved Termux/Android environment is incomplete");
  await verifyFeed();
  report.bootstrapVersion = run(plan.node, [plan.bootstrapSource, "--version"]);
  if (report.bootstrapVersion === plan.expectedVersion) throw new Error("Bootstrap must precede the target version");
  // Full argv stays only in the private plan; a legacy invocation may carry a pairing code.
  report.before = { worker: { pid: plan.oldWorker.pid, start: plan.oldWorker.start },
    launcher: { pid: plan.oldLauncher.pid, start: plan.oldLauncher.start },
    version: run(plan.node, [plan.oldWorker.args[1], "--version"]) };
  save();
  copyPreserved(plan.bootstrapSource, plan.bootstrapDestination, plan.bootstrapSha256);
  // Recheck immediately before stopping anything; an old tool call may have started during download.
  if (!same(plan.oldLauncher) || !same(plan.oldWorker) || digest(plan.config) !== plan.configSha256)
    throw new Error("Original runtime changed before handoff");
  const children = allProcesses().filter((item) => item.ppid === plan.oldWorker.pid);
  if (children.length) {
    report.deferred = "Legacy worker still has active child work";
    throw new Error(report.deferred);
  }
  phase("stopping-legacy");
  oldTouched = true;
  exactSignal(plan.oldLauncher);
  await until(() => !same(plan.oldLauncher), 10000, "legacy loop exit");
  exactSignal(plan.oldWorker);
  await until(() => !same(plan.oldWorker), 15000, "legacy worker exit");
  await until(() => currentPanes().length === 0, 10000, "legacy tmux session exit");
  if (matchingRelays().length) throw new Error("Another relay owns this config; switch stopped");
  replaceScript(plan.updatedScript, plan.updatedScriptSha256);
  scriptReplaced = true;
  phase("starting-bootstrap");
  launchSession();
  newStarted = true;
  await until(() => currentPanes().length === 1, 5000, "new tmux pane");
  newPane = info(currentPanes()[0].pid);
  if (!newPane) throw new Error("New tmux pane process could not be identified");
  tracked.set(newPane.pid, newPane);
  report.newPane = { pid: newPane.pid, start: newPane.start };
  let checkSent = false;
  const deadline = Date.now() + 150000;
  let status;
  do {
    snapshotNew();
    status = readStatus();
    if (status) {
      if (status.version === report.bootstrapVersion && !report.bootstrapObserved) {
        report.bootstrapObserved = { version: status.version, phase: status.phase, at: stamp() }; save();
      }
      if (!checkSent) {
        try { run(plan.node, [plan.bootstrapDestination, "update-check", "--config", plan.config], 8000); checkSent = true; }
        catch { /* the supervisor may still be acquiring its lock */ }
      }
      if (status.phase === "running" && status.version === plan.expectedVersion
          && status.supervisorVersion === plan.expectedVersion && status.sha256 === plan.expectedSha256
          && status.previousVersion === report.bootstrapVersion) break;
    }
    if (Date.now() >= deadline) throw new Error("Stable worker/supervisor did not prove the bootstrap OTA transition");
    await delay(600);
  } while (true);
  if (digest(plan.config) !== plan.configSha256 || digest(plan.liveScript) !== plan.updatedScriptSha256)
    throw new Error("Config or launcher changed during activation");
  verifyEnvironment();
  if (report.worker.entrySha256 !== plan.expectedSha256) throw new Error("Actual worker entry differs from the published artifact");
  report.runtime = { version: status.version, supervisorVersion: status.supervisorVersion,
    sha256: status.sha256, previousVersion: status.previousVersion, phase: status.phase };
  report.otaProven = true;
  report.originalDeviceId = plan.deviceId;
  report.passed = true;
  report.phase = "active-awaiting-external-tool";
  report.completedAt = stamp();
  save();
}
main().catch(async (error) => {
  report.error = String(error);
  if (oldTouched) {
    try { await rollback(); report.phase = "rolled-back"; }
    catch (rollbackError) { report.phase = "rollback-pending"; report.rollbackError = String(rollbackError); }
  } else report.phase = report.deferred ? "deferred" : "failed-before-switch";
  report.completedAt = stamp(); save(); process.exitCode = 1;
});