import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLinuxWorkspaceProvider, linuxWorkspaceRpc } from "../../src/computer/workspace-linux.js";
import { linuxWorkspaceHelper } from "../../src/computer/workspace-linux-helper.js";
import { runNative } from "../../src/computer/native.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext, WorkspaceResource } from "../../src/computer/workspace-types.js";

const evidenceDirectory = join(tmpdir(), "relay-linux-workspace-" + randomUUID());
// Deliberately exceed AF_UNIX's path limit in the durable journal. Native IPC
// must remain usable independently of the user's home and journal depth.
const directory = join(evidenceDirectory, "deep-journal-" + "x".repeat(160));
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(join(directory, "guardian-check.py"), linuxWorkspaceHelper);
const ctx = { timeoutMs: 15000 };
const created: ChildProcess[] = [];
const fixtureIdentities = new Map<number, ProcessIdentity>();
const caseNames: string[] = [];
interface ProcessIdentity { pid: number; start: string }
interface NativeState {
  phase: string;
  display?: string;
  guardian: ProcessIdentity;
  resources: Record<string, ProcessIdentity>;
  creationIntents?: Record<string, { stage: string; protocol: string }>;
  appLaunchIntent?: boolean;
  activeCommand?: ProcessIdentity;
  recovery?: { complete: boolean; outcome: string; ownedDisplayRemoved: boolean; details?: Record<string, unknown> };
}
function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? undefined : { pid, start: fields[19]! };
  } catch { return undefined; }
}
function matches(record: ProcessIdentity | undefined): boolean {
  return !!record && processIdentity(record.pid)?.start === record.start;
}
function nativeState(resource: WorkspaceResource): NativeState {
  return JSON.parse(readFileSync(join(String(resource.data.directory), "native-state.json"), "utf8")) as NativeState;
}
function killExact(record: ProcessIdentity) {
  assert.equal(matches(record), true, "fixture process identity changed");
  process.kill(record.pid, "SIGKILL");
}
function recordCase(test: string, details: Record<string, unknown> = {}) {
  caseNames.push(test);
  process.stdout.write(JSON.stringify({ test, passed: true, ...details }) + "\n");
}
function privateEnvironment(resource: WorkspaceResource): NodeJS.ProcessEnv {
  const current = nativeState(resource);
  assert.ok(current.display);
  return { ...testEnv, DISPLAY: current.display, XAUTHORITY: join(String(resource.data.directory), "Xauthority") };
}
async function inputState(resource: WorkspaceResource) {
  return JSON.parse(await command(["python3", "-c",
    "import json; from Xlib import display; d=display.Display(); p=d.screen().root.query_pointer(); " +
    "print(json.dumps(dict(x=p.root_x,y=p.root_y,buttons=p.mask&7936,keys=sum(int(b).bit_count() for b in d.query_keymap())))); d.close()"],
    privateEnvironment(resource))) as { x: number; y: number; buttons: number; keys: number };
}
function wrapperProcesses(resource: WorkspaceResource, name: string): ProcessIdentity[] {
  const config = join(String(resource.data.directory), "config.json");
  return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
    try {
      const argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0");
      const index = argv.indexOf("--exec-child");
      const record = processIdentity(Number(pid));
      return index >= 0 && argv[index + 4] === config && argv[index + 5] === name && record ? [record] : [];
    } catch { return []; }
  });
}
const nativeFixtures = new Map<string, { resource: WorkspaceResource; context: WorkspaceProviderContext }>();
function rememberFixture(resource: WorkspaceResource, context: WorkspaceProviderContext) {
  nativeFixtures.set(resource.instanceId, { resource, context });
}
const testEnv: NodeJS.ProcessEnv = { ...process.env };
delete testEnv.WAYLAND_DISPLAY; delete testEnv.DBUS_SESSION_BUS_ADDRESS;
delete testEnv.XDG_SESSION_ID; delete testEnv.XAUTHORITY;
testEnv.XDG_SESSION_TYPE = "x11";
async function command(args: string[], env = testEnv): Promise<string> {
  const result = await runNative({ command: args[0]!, args: args.slice(1), env }, ctx);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
}
async function ownedProcess(argv: string[], env = testEnv): Promise<ChildProcess> {
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: "ignore", detached: true });
  created.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const record = processIdentity(child.pid!);
  if (record) fixtureIdentities.set(child.pid!, record);
  return child;
}
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 12000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const result = await fn(); if (result !== undefined) return result; } catch { /* owned display is starting */ }
    await delay(100);
  }
  throw new Error("native condition timed out");
}
async function physicalState() {
  return { active: await command(["xdotool", "getactivewindow"]),
    pointer: await command(["xdotool", "getmouselocation", "--shell"]) };
}
async function run() {
  await command(["python3", "-m", "py_compile", join(directory, "guardian-check.py")]);
  const x = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-noreset"],
    { stdio: ["ignore", "ignore", "ignore", "pipe"], detached: true, env: testEnv });
  created.push(x);
  const display = await new Promise<string>((resolve, reject) => {
    x.once("error", reject);
    const stream = x.stdio[3]!;
    stream.once("data", chunk => resolve(":" + String(chunk).trim()));
    x.once("exit", code => reject(new Error("physical fixture Xvfb exited " + code)));
  });
  const physicalIdentity = processIdentity(x.pid!);
  if (physicalIdentity) fixtureIdentities.set(x.pid!, physicalIdentity);
  testEnv.DISPLAY = display;
  await command(["xdotool", "getdisplaygeometry"]);
  await ownedProcess(["openbox", "--sm-disable"]);
  await ownedProcess(["xterm", "-title", "Relay physical fixture", "-e", "cat"]);
  const physicalWindow = await waitFor(async () => (await command(["xdotool", "search", "--name", "^Relay physical fixture$"])).split("\n")[0] || undefined);
  await waitFor(async () => { await command(["xdotool", "windowactivate", "--sync", physicalWindow]); return true; });
  await command(["xdotool", "mousemove", "40", "50"]);
  const before = await waitFor(async () => {
    const state = await physicalState();
    return state.active === physicalWindow ? state : undefined;
  });
  const provider = createLinuxWorkspaceProvider(testEnv);
  const capabilities = await provider.probe(ctx);
  assert.equal(capabilities.available, true, JSON.stringify(capabilities));
  const resourceDirectory = join(directory, "handoff");
  mkdirSync(resourceDirectory, { mode: 0o700 });
  let resource: WorkspaceResource | undefined;
  const pc: WorkspaceProviderContext = { timeoutMs: 45000, journalDirectory: resourceDirectory, revocationPath: join(resourceDirectory, "revoked.json"),
    checkpoint: async r => { resource = r; rememberFixture(r, pc); writeFileSync(join(resourceDirectory, "ownership.json"), JSON.stringify(r)); } };
  const typed = join(directory, "typed.txt");
  const options: WorkspaceOpenOptions = { leaseId: randomUUID(), width: 640, height: 480,
    expiresAt: Date.now() + 60000, hardExpiresAt: Date.now() + 180000,
    launch: { executable: "/usr/bin/xterm", args: ["-title", "Relay private fixture", "-e", "/bin/sh", "-c",
      "IFS= read -r value; printf '%s' \"$value\" > '" + typed + "'; exec /bin/cat"] } };
  resource = await provider.open(options, pc);
  const heartbeat = setInterval(() => { void provider.renew(resource!, options.expiresAt, pc).catch(() => {}); }, 2000);
  try {
    await waitFor(async () => (await provider.inspect(resource!, ctx)).app?.title?.includes("Relay private fixture") ? true : undefined);
    await provider.act(resource, { type: "text", text: "Relay42" }, ctx);
    await provider.act(resource, { type: "key", keys: ["Return"] }, ctx);
    await waitFor(async () => existsSync(typed) ? true : undefined);
    assert.equal(readFileSync(typed, "utf8"), "Relay42");
    const screenshot = await provider.capture(resource, ctx);
    assert.equal(screenshot.display.width, 640); assert.equal(screenshot.display.height, 480);
    writeFileSync(join(directory, "private.png"), screenshot.data);
    assert.deepEqual(await physicalState(), before, "private input changed physical focus/cursor");
    const recovered = await provider.recover(resource, options, "disconnected", pc);
    assert.equal(recovered.complete, true, JSON.stringify(recovered));
    assert.equal(recovered.outcome, "handoff-viewer");
    assert.equal(recovered.inputRevoked, true);
    assert.equal(recovered.details?.physicalViewerVisible, true);
    await assert.rejects(() => provider.act(resource!, { type: "text", text: "forbidden" }, ctx));
    assert.equal(readFileSync(typed, "utf8"), "Relay42");
    recordCase("input-isolation-and-visible-handoff", { recovery: recovered });
  } finally { clearInterval(heartbeat); }

  const emptyDirectory = join(directory, "expiry");
  mkdirSync(emptyDirectory, { mode: 0o700 });
  const ec: WorkspaceProviderContext = { timeoutMs: 45000, journalDirectory: emptyDirectory, revocationPath: join(emptyDirectory, "revoked.json"),
    checkpoint: async r => { rememberFixture(r, ec); } };
  const emptyOptions: WorkspaceOpenOptions = { leaseId: randomUUID(), width: 640, height: 480,
    expiresAt: Date.now() + 60000, hardExpiresAt: Date.now() + 180000 };
  const empty = await provider.open(emptyOptions, ec);
  await provider.renew(empty, Date.now() + 2000, ec);
  const nativeFile = join(String(empty.data.directory), "native-state.json");
  const expired = await waitFor(async () => {
    const s = JSON.parse(readFileSync(nativeFile, "utf8")) as { phase: string; recovery?: Record<string, unknown> };
    return s.phase === "empty" ? s : undefined;
  }, 15000);
  assert.equal(expired.recovery?.complete, true);
  assert.equal(expired.recovery?.ownedDisplayRemoved, true);
  recordCase("native-expiry-removes-owned-empty-display", { recovery: expired.recovery });
  const lostDirectory = join(directory, "lost-broker");
  mkdirSync(lostDirectory, { mode: 0o700 });
  const lostContext: WorkspaceProviderContext = { timeoutMs: 45000, journalDirectory: lostDirectory,
    revocationPath: join(lostDirectory, "revoked.json"), checkpoint: async r => { rememberFixture(r, lostContext); } };
  const lostOptions: WorkspaceOpenOptions = { leaseId: randomUUID(), width: 640, height: 480,
    expiresAt: Date.now() + 60000, hardExpiresAt: Date.now() + 180000,
    launch: { executable: "/usr/bin/xterm", args: ["-title", "Relay broker-loss fixture", "-e", "/bin/cat"] } };
  const lost = await provider.open(lostOptions, lostContext);
  const lostFile = join(String(lost.data.directory), "native-state.json");
  const returned = await waitFor(async () => {
    const current = JSON.parse(readFileSync(lostFile, "utf8")) as { phase: string; recovery?: { complete: boolean; outcome: string; details?: { reason?: string } } };
    return current.phase === "returned" ? current : undefined;
  }, 30000);
  assert.equal(returned.recovery?.complete, true);
  assert.equal(returned.recovery?.outcome, "handoff-viewer");
  assert.equal(returned.recovery?.details?.reason, "broker_lost");
  await assert.rejects(() => provider.capture(lost, ctx));
  recordCase("lost-broker-native-watchdog-returns-app");

  const revokedDirectory = join(directory, "revoked-before-native-start");
  mkdirSync(revokedDirectory, { mode: 0o700 });
  let cancelled: WorkspaceResource | undefined;
  const revokePath = join(revokedDirectory, "revoked.json");
  const revokedContext: WorkspaceProviderContext = { timeoutMs: 45000, journalDirectory: revokedDirectory,
    revocationPath: revokePath, checkpoint: async value => {
      cancelled = value;
      rememberFixture(value, revokedContext);
      writeFileSync(revokePath, JSON.stringify({ reason: "owner_lost" }));
      // Simulate a close racing the initial checkpoint before the native process
      // and its control socket exist. Recovery must not enable late creation.
      await provider.recover(value, emptyOptions, "owner_lost", { ...revokedContext, checkpoint: async () => {} });
    } };
  await assert.rejects(() => provider.open({ ...emptyOptions, leaseId: randomUUID(), expiresAt: Date.now() + 60000,
    hardExpiresAt: Date.now() + 180000 }, revokedContext));
  assert.ok(cancelled);
  const nativeCancelled = await waitFor(async () => {
    const current = JSON.parse(readFileSync(join(String(cancelled!.data.directory), "native-state.json"), "utf8")) as {
      phase: string; resources: Record<string, unknown>; recovery?: { complete: boolean }
    };
    return current.recovery?.complete ? current : undefined;
  });
  assert.ok(nativeCancelled.recovery);
  assert.equal(nativeCancelled.recovery.complete, true);
  assert.deepEqual(nativeCancelled.resources, {});
  recordCase("revoke-fences-delayed-native-start");


  function fixtureContext(name: string, signal?: AbortSignal, instrument?: (source: string) => string) {
    const fixtureDirectory = join(directory, name);
    mkdirSync(fixtureDirectory, { mode: 0o700 });
    let checkpointed: WorkspaceResource | undefined;
    const context: WorkspaceProviderContext = { timeoutMs: 45000, journalDirectory: fixtureDirectory,
      revocationPath: join(fixtureDirectory, "revoked.json"), ...(signal ? { signal } : {}),
      checkpoint: async value => {
        if (!checkpointed && instrument) writeFileSync(String(value.data.helper), instrument(linuxWorkspaceHelper), { mode: 0o600 });
        checkpointed = value; rememberFixture(value, context);
      } };
    const options: WorkspaceOpenOptions = { leaseId: randomUUID(), width: 640, height: 480,
      expiresAt: Date.now() + 90000, hardExpiresAt: Date.now() + 180000 };
    return { context, options, resource: () => checkpointed };
  }

  // One real long-lived xdotool command holds a private mouse button, waits,
  // then attempts a trailing move. Kill the guardian while the button is down.
  const gestureFixture = fixtureContext("guardian-mid-input");
  const gestureOptions = { ...gestureFixture.options, launch: {
    executable: "/usr/bin/xterm", args: ["-title", "Relay interrupted gesture fixture", "-e", "/bin/cat"] } };
  const gesture = await provider.open(gestureOptions, gestureFixture.context);
  await waitFor(async () => (await provider.inspect(gesture, ctx)).app?.title?.includes("interrupted gesture") ? true : undefined);
  await command(["xdotool", "mousemove", "950", "720"]);
  const gesturePhysical = await physicalState();
  const pendingGesture = linuxWorkspaceRpc({ runtimeDirectory: String(gesture.data.runtimeDirectory), secret: String(gesture.data.secret) },
    { operation: "execute", command: "/usr/bin/xdotool",
      args: ["mousemove", "140", "160", "mousedown", "1", "sleep", "5", "mousemove", "550", "400", "mouseup", "1"],
      timeoutMs: 10000 }, { timeoutMs: 12000 }).then(() => ({ resolved: true }), () => ({ resolved: false }));
  await waitFor(async () => (await inputState(gesture)).buttons === 256 ? true : undefined);
  const runningGesture = nativeState(gesture);
  assert.ok(runningGesture.activeCommand);
  const commandRecord = runningGesture.activeCommand;
  assert.equal(matches(commandRecord), true);
  assert.deepEqual(await physicalState(), gesturePhysical);
  const killedAt = Date.now();
  killExact(runningGesture.guardian);
  assert.equal((await pendingGesture).resolved, false, "killed guardian acknowledged a completed gesture");
  await waitFor(async () => !matches(commandRecord) ? true : undefined, 3000);
  const gestureRecovery = await provider.recover(gesture, gestureOptions, "guardian_killed_during_input",
    { ...gestureFixture.context, timeoutMs: 15000 });
  assert.equal(gestureRecovery.complete, true, JSON.stringify(gestureRecovery));
  assert.equal(gestureRecovery.outcome, "handoff-viewer");
  const afterRecoveryInput = await inputState(gesture);
  assert.equal(afterRecoveryInput.buttons, 0); assert.equal(afterRecoveryInput.keys, 0);
  assert.notEqual(afterRecoveryInput.x, 550, "trailing input ran during recovery");
  await delay(Math.max(0, killedAt + 5500 - Date.now()));
  assert.deepEqual(await inputState(gesture), afterRecoveryInput, "orphan input ran after visible handoff");
  assert.equal(matches(commandRecord), false);
  recordCase("guardian-kill-during-input-revokes-before-handoff",
    { originalCommandGone: true, noTrailingInput: true, heldInputReleased: true, physicalInputUnchanged: true,
      recovery: gestureRecovery });

  async function killedDuringCreate(name: string, boundary: string, target: string | undefined, launch?: WorkspaceOpenOptions["launch"]) {
    const aborter = new AbortController();
    const marker = "# relay-test-boundary: " + boundary;
    const patched = (source: string) => {
      assert.equal(source.split(marker).length, 2, "missing or ambiguous fixture boundary");
      return source.replace(marker, (target ? "if name == " + JSON.stringify(target) + ": " : "") +
        "os.kill(os.getpid(), signal.SIGSTOP)");
    };
    const fixture = fixtureContext(name, aborter.signal, patched);
    const options = { ...fixture.options, ...(launch ? { launch } : {}) };
    const opening = provider.open(options, fixture.context).then(
      () => ({ resolved: true }), error => ({ resolved: false, error: String(error) }));
    const current = await waitFor(async () => {
      const value = fixture.resource();
      if (!value) return undefined;
      const state = nativeState(value);
      const stat = readFileSync("/proc/" + state.guardian.pid + "/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "T" ? { value, state } : undefined;
    }, 30000);
    const wrappers = target ? wrapperProcesses(current.value, target) : [];
    if (target) assert.equal(wrappers.length, 1, "expected one blocked pre-GO wrapper");
    killExact(current.state.guardian);
    aborter.abort();
    assert.equal((await opening).resolved, false);
    for (const wrapper of wrappers) await waitFor(async () => !matches(wrapper) ? true : undefined, 3000);
    const cleanContext = { ...fixture.context, signal: undefined, timeoutMs: 15000 };
    const recovery = await provider.recover(current.value, options, "guardian_killed_during_creation", cleanContext);
    assert.equal(recovery.complete, true, JSON.stringify(recovery));
    return { resource: current.value, before: current.state, after: nativeState(current.value), recovery };
  }

  const beforeXvfb = await killedDuringCreate("before-xvfb-checkpoint", "before-process-checkpoint", "xvfb");
  assert.equal(beforeXvfb.before.creationIntents?.xvfb?.stage, "prepared");
  assert.equal(beforeXvfb.before.resources.xvfb, undefined);
  assert.equal(readFileSync(join(String(beforeXvfb.resource.data.directory), "display-number"), "utf8"), "");
  assert.equal(beforeXvfb.recovery.ownedDisplayRemoved, true);
  recordCase("guardian-kill-before-xvfb-checkpoint-does-not-create-display",
    { durableIntentBeforeSpawn: true, uncommittedWrapperExited: true, displayNeverAllocated: true, recovery: beforeXvfb.recovery });

  const allocatedXvfb = await killedDuringCreate("after-xvfb-allocation", "after-xvfb-display-allocation", undefined);
  assert.equal(allocatedXvfb.before.display, null);
  assert.ok(allocatedXvfb.before.resources.xvfb);
  assert.equal(matches(allocatedXvfb.before.resources.xvfb), false);
  assert.match(allocatedXvfb.after.display!, /^:\d+$/);
  assert.equal(allocatedXvfb.recovery.ownedDisplayRemoved, true);
  recordCase("guardian-kill-after-xvfb-exec-recovers-display-number",
    { durableDisplayNumberRecovered: true, exactOwnedServerRemoved: true, recovery: allocatedXvfb.recovery });

  const mustNotLaunch = join(directory, "must-not-launch.txt");
  const appBeforeCheckpoint = await killedDuringCreate("before-app-checkpoint", "before-process-checkpoint", "app",
    { executable: "/usr/bin/python3", args: ["-c",
      "from pathlib import Path; Path(" + JSON.stringify(mustNotLaunch) + ").write_text('executed')"] });
  assert.equal(appBeforeCheckpoint.before.appLaunchIntent, true);
  assert.equal(appBeforeCheckpoint.before.resources.app, undefined);
  assert.equal(appBeforeCheckpoint.before.creationIntents?.app?.stage, "prepared");
  assert.equal(existsSync(mustNotLaunch), false, "uncommitted application was allowed to execute");
  assert.equal(appBeforeCheckpoint.recovery.outcome, "handoff-viewer");
  recordCase("guardian-kill-before-app-checkpoint-does-not-launch",
    { durableAppIntent: true, uncommittedWrapperExited: true, appNeverExecuted: true, recovery: appBeforeCheckpoint.recovery });

  // The owned app is already running but deliberately has no mapped X window.
  // Recovery must preserve it rather than treating an empty window list as an
  // empty desktop. The same PID execs xterm after the handoff is visible.
  const delayed = fixtureContext("app-before-window-map");
  const appStarted = join(directory, "delayed-app-started");
  const allowMap = join(directory, "allow-delayed-app-map");
  const delayedProgram = "import os,time; from pathlib import Path; Path(" + JSON.stringify(appStarted) +
    ").write_text('started');\nwhile not Path(" + JSON.stringify(allowMap) + ").exists(): time.sleep(.02)\n" +
    "os.execv('/usr/bin/xterm',['xterm','-title','Relay delayed-map fixture','-e','/bin/cat'])";
  const delayedOptions = { ...delayed.options, launch: { executable: "/usr/bin/python3", args: ["-c", delayedProgram] } };
  const delayedResource = await provider.open(delayedOptions, delayed.context);
  await waitFor(async () => existsSync(appStarted) ? true : undefined);
  const delayedNative = nativeState(delayedResource);
  assert.ok(delayedNative.resources.app);
  const appRecord = delayedNative.resources.app;
  const noWindows = await command(["python3", "-c",
    "from Xlib import X,display; d=display.Display(); p=d.screen().root.get_full_property(d.intern_atom('_NET_CLIENT_LIST'),X.AnyPropertyType); print(len(p.value) if p else 0); d.close()"],
    privateEnvironment(delayedResource));
  assert.equal(noWindows, "0");
  killExact(delayedNative.guardian);
  const delayedRecovery = await provider.recover(delayedResource, delayedOptions, "guardian_killed_before_app_map", delayed.context);
  assert.equal(delayedRecovery.complete, true, JSON.stringify(delayedRecovery));
  assert.equal(delayedRecovery.outcome, "handoff-viewer");
  assert.equal(matches(appRecord), true, "unmapped app was terminated by empty cleanup");
  writeFileSync(allowMap, "go");
  await waitFor(async () => (await command(["xdotool", "search", "--name", "^Relay delayed-map fixture$"],
    privateEnvironment(delayedResource))).length ? true : undefined);
  assert.equal(matches(appRecord), true, "app identity changed during return");
  recordCase("guardian-kill-before-app-window-map-preserves-app",
    { initiallyNoMappedWindows: true, sameAppPidPreserved: true, windowMappedAfterHandoff: true, recovery: delayedRecovery });

  const testedHarnessSha256 = createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex");
  const helperSha256 = createHash("sha256").update(linuxWorkspaceHelper).digest("hex");
  writeFileSync(join(evidenceDirectory, "receipt.json"), JSON.stringify({ passed: caseNames.length, directory, display,
    physicalStateUnchanged: true, testedHarnessSha256, helperSha256,
    deepJournalBytes: Buffer.byteLength(directory), shortPrivateRuntime: String(resource!.data.runtimeDirectory),
    faultInjection: "Three copied helpers replace one declared boundary comment with SIGSTOP; production guardian code is otherwise unchanged.",
    cases: caseNames }, null, 2));
  process.stdout.write(JSON.stringify({ passed: caseNames.length, directory, evidenceDirectory, testedHarnessSha256, helperSha256 }) + "\n");

}
run().catch(error => {
  process.stderr.write(JSON.stringify({ passed: false, directory, error: String(error), stack: (error as Error).stack }) + "\n");
  process.exitCode = 1;
}).finally(async () => {
  // Every native resource is remembered at its first durable checkpoint, even
  // when open() throws. Fence creation before cleaning only our own fixtures.
  const provider = createLinuxWorkspaceProvider(testEnv);
  for (const { resource, context } of nativeFixtures.values()) {
    try {
      writeFileSync(context.revocationPath, JSON.stringify({ reason: "test_fixture_complete" }));
      await provider.recover(resource, { leaseId: resource.leaseId, width: resource.display.width, height: resource.display.height,
        expiresAt: Date.now(), hardExpiresAt: Date.now() }, "test_fixture_complete", { ...context, timeoutMs: 15000 });
      const native = JSON.parse(readFileSync(join(String(resource.data.directory), "native-state.json"), "utf8")) as {
        resources: Record<string, ProcessIdentity>; activeCommand?: ProcessIdentity; guardian?: ProcessIdentity
      };
      const records = [...Object.values(native.resources), ...(native.activeCommand ? [native.activeCommand] : [])];
      for (const record of records) {
        try {
          if (matches(record)) process.kill(-record.pid, "SIGTERM");
        } catch { /* exact fixture PID has already exited */ }
      }
      if (native.guardian && matches(native.guardian)) process.kill(native.guardian.pid, "SIGKILL");
    } catch { /* fixture failed before producing a native receipt */ }
  }
  for (const child of created.reverse()) {
    try { if (child.pid && matches(fixtureIdentities.get(child.pid))) process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
  }
});