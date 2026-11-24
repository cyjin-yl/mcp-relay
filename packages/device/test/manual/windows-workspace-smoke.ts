import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createWindowsWorkspaceProvider } from "../../src/computer/workspace-windows.js";
import { nativeEnvironment, runNative } from "../../src/computer/native.js";
import { ComputerError, type ComputerAction, type NativeContext } from "../../src/computer/types.js";
import { ANODE_EXECUTABLE_BYTES, ANODE_EXECUTABLE_SHA256, ANODE_RUNTIME_VERSION, ANODE_SOURCE_COMMIT,
  WINDOWS_WORKSPACE_GUARDIAN, WINDOWS_WORKSPACE_OWNER, WINDOWS_HIDDEN_LAUNCHER, anodeRequest,
  sha256File, verifyAnodeRuntime, windowsPowerShell, windowsScriptHost, windowsWorkspaceNative, writePrivateJson } from "../../src/computer/workspace-windows-runtime.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext, WorkspaceResource } from "../../src/computer/workspace-types.js";

declare const RELAY_WINDOWS_FIXTURE_SOURCE: string;
declare const RELAY_WINDOWS_OBSERVER_SOURCE: string;
const root = join(homedir(), ".mcp-relay", "computer", "windows", "validation-20261124");
const runtime = { sourceCommit: ANODE_SOURCE_COMMIT, dotnetRuntime: ANODE_RUNTIME_VERSION,
  executableSha256: ANODE_EXECUTABLE_SHA256, executableBytes: ANODE_EXECUTABLE_BYTES };
const expectedText = "你好，隔离桌面🙂";
const provider = createWindowsWorkspaceProvider();
interface Rectangle { x: number; y: number; width: number; height: number }
interface Fixture {
  nonce: string; pid: number; session: number; started: string; closed: boolean; text: string; clicks: number; warps: number;
  textBox: Rectangle; clickButton: Rectangle; pointerButton: Rectangle;
}
type Evidence = Record<string, unknown> & { gates: Record<string, boolean> };
async function json<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function progress(stage: string, details: Record<string, unknown> = {}) {
  await appendFile(join(root, "native-validation-progress.jsonl"), JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + "\n", { mode: 0o600 });
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sameParent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ["foreground", "cursorX", "cursorY", "clipboardSequence", "keyboardLayout"].every(k => a[k] === b[k])
    && JSON.stringify(a.screens) === JSON.stringify(b.screens) && a.consoleVisible === false && b.consoleVisible === false;
}
async function observeHost(request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
  const code = RELAY_WINDOWS_OBSERVER_SOURCE.replace("__REQUEST__", Buffer.from(JSON.stringify(request), "utf8").toString("base64"));
  const loader = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  const result = await runNative({ command: windowsPowerShell(), args: ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")], input: code,
    env: nativeEnvironment(), maxOutputBytes: 128 * 1024 }, context);
  if (result.exitCode !== 0) throw new Error("The windowless parent-session observer failed: " + result.stderr.toString("utf8").slice(0, 2000));
  return JSON.parse(result.stdout.toString("utf8").replace(/^\uFEFF/, "").trim()) as Record<string, unknown>;
}
async function prepareFixture(context: NativeContext) {
  const sourceSha256 = createHash("sha256").update(RELAY_WINDOWS_FIXTURE_SOURCE).digest("hex");
  const sourcePath = join(root, "fixture-" + sourceSha256.slice(0, 16) + ".cs");
  const executable = sourcePath.slice(0, -3) + ".exe";
  const existing = await json(executable + ".receipt.json");
  if (existing?.sourceSha256 === sourceSha256 && existing.executableSha256 === await sha256File(executable).catch(() => ""))
    return { executable, sourceSha256, executableSha256: String(existing.executableSha256) };
  await writeFile(sourcePath, RELAY_WINDOWS_FIXTURE_SOURCE, { mode: 0o600 });
  const systemRoot = win32.resolve(windowsPowerShell(), "..", "..", "..", "..");
  const compiler = win32.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const result = await runNative({ command: compiler, args: ["/nologo", "/target:winexe", "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll", "/out:" + executable, sourcePath],
    env: nativeEnvironment(), maxOutputBytes: 128 * 1024 }, { ...context, timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new Error("The controlled Windows fixture did not compile: " + result.stdout.toString("utf8").slice(0, 2000));
  const receipt = { executable, sourceSha256, executableSha256: await sha256File(executable) };
  await writePrivateJson(executable + ".receipt.json", receipt); return receipt;
}
function winQuote(value: string) { return '"' + value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1") + '"'; }
async function prepareLauncher() {
  const executable = process.execPath, entryPoint = resolve(process.argv[1]!);
  for (const path of [executable, entryPoint, root]) if (!win32.isAbsolute(path) || /[%\r\n\0]/.test(path)) throw new Error("Unsafe validation launcher path.");
  const command = [executable, entryPoint, "open-sign-in"].map(winQuote).join(" ");
  const vb = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const launcherPath = join(root, "validate-isolated-sign-in.vbs");
  const script = ["Option Explicit", "On Error Resume Next", "Dim shell, code", 'Set shell = CreateObject("WScript.Shell")',
    "shell.CurrentDirectory = " + vb(root), "code = shell.Run(" + vb(command) + ", 0, True)",
    "If Err.Number <> 0 Then WScript.Quit 1", "WScript.Quit code", ""].join("\r\n");
  await writeFile(launcherPath, script, { mode: 0o600 });
  const receipt = { schema: 1, launcherPath, launcherSha256: await sha256File(launcherPath),
    harnessSha256: await sha256File(entryPoint), runtime, createdAt: new Date().toISOString(),
    launchNow: false, interactiveSignInOnlyByUser: true };
  await writePrivateJson(join(root, "launcher-receipt.json"), receipt); return receipt;
}
async function waitFixture(path: string, nonce: string, session: number, predicate: (f: Fixture) => boolean): Promise<Fixture> {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const f = await json<Fixture>(path);
    if (f?.nonce === nonce && f.session === session && f.closed === false && predicate(f)) return f;
    await delay(100);
  }
  throw new Error("The owned child-session fixture did not reach the expected state.");
}
async function observeRecovery(packetPath: string) {
  if (!win32.isAbsolute(packetPath) || win32.relative(root, packetPath).startsWith("..")) throw new Error("Invalid validation observer packet.");
  const packet = await json<{ resource: WorkspaceResource; fixturePath: string; fixtureNonce: string; evidence: Evidence }>(packetPath);
  if (!packet || packet.resource.providerId !== "windows-anode-child-session") throw new Error("Missing owned validation packet.");
  const { resource, fixturePath, fixtureNonce } = packet, d = resource.data;
  const stateFile = String(d.stateFile), evidence = packet.evidence;
  const context: NativeContext = { timeoutMs: 10000 };
  await writePrivateJson(packetPath + ".observer-ready.json", { instanceId: resource.instanceId, pid: process.pid, at: Date.now() });
  let recovery: Record<string, unknown> | undefined;
  try {
    const until = Date.now() + 22000;
    while (Date.now() < until) {
      recovery = await json(stateFile + ".recovery.json");
      if (recovery?.complete === true) break;
      await delay(200);
    }
    const exitRequest = await json(packetPath + ".owner-exit.json");
    const recoveredAt = Date.now();
    const native = await anodeRequest(String(d.channel), { op: "status", agentId: String(d.agentId) }, context);
    const lease = record(native.lease);
    const fixture = await waitFixture(fixturePath, fixtureNonce, Number(d.childSession), () => true);
    const processIdentity = await windowsWorkspaceNative({ op: "inspect", brokerPid: fixture.pid }, context);
    let denied = false;
    try { await provider.act(resource, { type: "move", x: 0, y: 0 }, context); }
    catch (error) { denied = error instanceof ComputerError && error.code === "WORKSPACE_HANDED_OFF"; }
    const hostAfter = await observeHost({ op: "sample" }, context);
    const elapsedMs = recoveredAt - Number(exitRequest?.at);
    Object.assign(evidence.gates, {
      revokeOnOwnerDeath: recovery?.complete === true && recovery.reason === "owner_lost"
        && recovery.inputRevoked === true && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 15000,
      handoffViewerVisible: recovery?.outcome === "handoff-viewer" && native.viewerVisible === true && native.viewOnly === true
        && native.channel === d.channel && native.session === d.childSession && native.parentSession === d.parentSession,
      nativeLeaseRevoked: Object.hasOwn(lease, "ownerAgentId") && lease.ownerAgentId !== d.agentId,
      postRecoveryInputRejected: denied,
      applicationsPreserved: fixture.closed === false && processIdentity.brokerSession === d.childSession
        && processIdentity.brokerStarted === fixture.started,
      parentUnchangedAfterRecovery: sameParent(record(evidence.parentBefore), hostAfter),
    });
    evidence.recovery = recovery; evidence.recoveryElapsedMs = elapsedMs; evidence.parentAfterRecovery = hostAfter;
    evidence.status = Object.values(evidence.gates).every(Boolean) ? "passed" : "failed";
    evidence.completedAt = new Date().toISOString();
    await writePrivateJson(join(root, "child-session-native.json"), evidence);
    await progress("owner-loss-recovery-complete", { status: evidence.status, gates: evidence.gates, recoveryElapsedMs: elapsedMs });
  } catch (error) {
    await writePrivateJson(join(root, "child-session-native.json"), { ...evidence, status: "failed", recovery,
      failure: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
    await progress("recovery-observer-failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
async function validateNative(resource: WorkspaceResource, options: WorkspaceOpenOptions, context: WorkspaceProviderContext,
  fixturePath: string, fixtureNonce: string, fixtureReceipt: Awaited<ReturnType<typeof prepareFixture>>, assertHeartbeat: () => void) {
  const d = resource.data, child = Number(d.childSession);
  const fixture = await waitFixture(fixturePath, fixtureNonce, child, () => true);
  // The invisible owned viewer is placed under the existing pointer. The host
  // cursor is never moved to make this test pass.
  await observeHost({ op: "place-hidden-viewer", data: d }, context);
  await delay(250);
  const before = await observeHost({ op: "sample" }, context);
  const start = await provider.inspect(resource, context), guardBefore = record(start.details?.pointerGuard);
  const act = async (action: ComputerAction) => { assertHeartbeat(); await provider.capture(resource, context); await provider.act(resource, action, context); assertHeartbeat(); };
  const middle = (r: Rectangle) => ({ x: r.x + Math.floor(r.width / 2), y: r.y + Math.floor(r.height / 2) });
  await act({ type: "click", ...middle(fixture.textBox) });
  await act({ type: "key", keys: ["ctrl", "a"] });
  await act({ type: "text", text: expectedText });
  await waitFixture(fixturePath, fixtureNonce, child, f => f.text === expectedText);
  await act({ type: "click", ...middle(fixture.clickButton) });
  await waitFixture(fixturePath, fixtureNonce, child, f => f.clicks === 1);
  await act({ type: "click", ...middle(fixture.pointerButton) });
  const observed = await waitFixture(fixturePath, fixtureNonce, child, f => f.warps >= 1);
  await delay(250);
  const state = await provider.inspect(resource, context), guardAfter = record(state.details?.pointerGuard);
  const screenshot = await provider.capture(resource, context);
  const screenshotPath = join(dirname(String(d.stateFile)), "native-child.png");
  await writeFile(screenshotPath, screenshot.data, { mode: 0o600 });
  const after = await observeHost({ op: "sample" }, context);
  const evidence: Evidence = {
    schema: 1, kind: "windows-workspace-native", platform: "win32", providerId: resource.providerId,
    status: "awaiting-owner-loss-recovery", runtime, harnessSha256: await sha256File(resolve(process.argv[1]!)),
    fixtureSourceSha256: fixtureReceipt.sourceSha256, fixtureExecutableSha256: fixtureReceipt.executableSha256,
    resourceInstance: resource.instanceId, parentSession: d.parentSession, childSession: d.childSession,
    originalExpiresAt: options.expiresAt, originalHardExpiresAt: options.hardExpiresAt,
    screenshotPath, screenshotSha256: createHash("sha256").update(screenshot.data).digest("hex"),
    screenshotBytes: screenshot.data.length, fixture: { pid: observed.pid, session: observed.session, text: observed.text, clicks: observed.clicks, warps: observed.warps },
    parentBefore: before, parentAfterInput: after, pointerGuardBefore: guardBefore, pointerGuardAfter: guardAfter,
    gates: {
      nativeChildCreated: child > 0 && child !== d.parentSession && observed.session === child && state.displayKind === "virtual",
      screenCaptured: screenshot.data.length > 1000 && screenshot.display.id === resource.display.id
        && screenshot.display.instanceId === resource.instanceId,
      unicodeInput: observed.text === expectedText, clickInput: observed.clicks === 1,
      pointerGuard: guardAfter.installed === true && Number(guardAfter.patchedImports) > 0
        && Number(guardAfter.suppressed) > Number(guardBefore.suppressed) && guardAfter.forwarded === guardBefore.forwarded,
      parentUnchangedDuringInput: sameParent(before, after),
    },
  };
  await writePrivateJson(join(root, "child-session-native.json"), evidence);
  if (!Object.values(evidence.gates).every(Boolean)) throw new Error("Native workspace verification failed; see child-session-native.json.");
  const packetPath = join(dirname(String(d.stateFile)), "validation-observer.json");
  await writePrivateJson(packetPath, { resource, fixturePath, fixtureNonce, evidence });
  await windowsWorkspaceNative({ op: "launch", taskName: "McpRelay-ValidationObserver-" + resource.instanceId,
    executable: windowsScriptHost(), parentSession: d.parentSession,
    arguments: ["//B", "//Nologo", join(dirname(String(d.stateFile)), "hidden-launcher.vbs"),
      process.execPath, resolve(process.argv[1]!), "observe-recovery", packetPath] }, context);
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const ready = await json(packetPath + ".observer-ready.json");
    if (ready?.instanceId === resource.instanceId) {
      assertHeartbeat();
      await progress("native-input-passed-testing-owner-loss", { resourceInstance: resource.instanceId });
      await writePrivateJson(packetPath + ".owner-exit.json", { at: Date.now(), pid: process.pid, instanceId: resource.instanceId });
      process.kill(process.pid, "SIGKILL");
      throw new Error("The owner-loss probe did not terminate its own Node process.");
    }
    await delay(100);
  }
  throw new Error("The independent recovery observer did not start; owner-loss testing was refused.");
}
async function main() {
  await mkdir(root, { recursive: true });
  const mode = process.argv[2] ?? "preflight";
  if (mode === "observe-recovery") { await observeRecovery(process.argv[3] ?? ""); return; }
  let resource: WorkspaceResource | undefined;
  const context: WorkspaceProviderContext = {
    timeoutMs: 60000, journalDirectory: root, revocationPath: join(root, "revoked.json"),
    async checkpoint(value) { resource = value; await writePrivateJson(join(root, "last-resource.json"), value); },
  };
  if (mode === "preflight" || mode === "prepare") {
    await verifyAnodeRuntime();
    await writeFile(join(root, "guardian-syntax.ps1"), WINDOWS_WORKSPACE_GUARDIAN, { mode: 0o600 });
    await writeFile(join(root, "owner-syntax.ps1"), WINDOWS_WORKSPACE_OWNER, { mode: 0o600 });
    await writeFile(join(root, "observer-syntax.ps1"), RELAY_WINDOWS_OBSERVER_SOURCE, { mode: 0o600 });
    await writeFile(join(root, "hidden-launcher.vbs"), WINDOWS_HIDDEN_LAUNCHER, { mode: 0o600 });
    const native = await windowsWorkspaceNative({ op: "inspect", brokerPid: process.pid }, context);
    const prepared = mode === "prepare" ? { fixture: await prepareFixture(context), launcher: await prepareLauncher() } : {};
    console.log(JSON.stringify({ ok: true, mode, native, ...prepared, probe: await provider.probe(context) })); return;
  }
  if (mode === "recover") {
    resource = await json<WorkspaceResource>(join(root, "last-resource.json"));
    if (!resource) throw new Error("No owned validation resource.");
    const d = resource.data; context.revocationPath = String(d.revocationPath);
    console.log(JSON.stringify(await provider.recover(resource, { leaseId: resource.leaseId, width: resource.display.width,
      height: resource.display.height, expiresAt: Number(d.expiresAt), hardExpiresAt: Number(d.hardExpiresAt) }, "recovery", context))); return;
  }
  if (mode !== "open" && mode !== "open-sign-in") throw new Error("Unknown Windows workspace validation mode.");
  const interactive = mode === "open-sign-in", nonce = randomUUID();
  const fixtureReceipt = interactive ? await prepareFixture(context) : undefined;
  const fixturePath = join(root, "fixture-state-" + nonce + ".json");
  const now = Date.now();
  context.journalDirectory = join(root, "run-" + nonce);
  context.revocationPath = join(context.journalDirectory, "revoked.json");
  await mkdir(context.journalDirectory, { recursive: true });
  const options: WorkspaceOpenOptions = { leaseId: "relay-validation-" + nonce, width: 1280, height: 720,
    expiresAt: now + 120000, hardExpiresAt: now + 150000, interactiveSignIn: interactive,
    ...(fixtureReceipt ? { launch: { executable: fixtureReceipt.executable, args: [fixturePath, nonce] } } : {}) };
  let heartbeat: ReturnType<typeof setInterval> | undefined, renewing = Promise.resolve(), heartbeatError: unknown;
  try {
    await progress(interactive ? "awaiting-native-sign-in" : "automatic-open-started", { leaseId: options.leaseId, expiresAt: options.expiresAt, hardExpiresAt: options.hardExpiresAt });
    resource = await provider.open(options, context);
    await progress("native-ready", { resourceInstance: resource.instanceId, childSession: resource.data.childSession });
    heartbeat = setInterval(() => {
      renewing = renewing.then(async () => { if (resource) await provider.renew(resource, options.expiresAt, { ...context, timeoutMs: 3000 }); })
        .catch(error => { heartbeatError = error; });
    }, 2000);
    if (interactive && fixtureReceipt) {
      await validateNative(resource, options, context, fixturePath, nonce, fixtureReceipt, () => { if (heartbeatError) throw heartbeatError; });
    } else {
      const state = await provider.inspect(resource, context), shot = await provider.capture(resource, context);
      await writeFile(join(root, "isolated-screen.png"), shot.data, { mode: 0o600 });
      if (heartbeatError) throw heartbeatError;
      console.log(JSON.stringify({ ok: true, mode, state, screenshotBytes: shot.data.length }));
      console.log(JSON.stringify({ recovery: await provider.recover(resource, options, "explicit", context) }));
    }
  } catch (error) {
    if (resource?.leaseId === options.leaseId) {
      try {
        const recovery = await provider.recover(resource, options, "open_failed", context);
        await progress("open-or-validation-failed", { recovery, code: error instanceof ComputerError ? error.code : "VALIDATION_FAILED", message: error instanceof Error ? error.message : String(error) });
        console.log(JSON.stringify({ recovery }));
      } catch (recoveryError) { await progress("recovery-pending", { message: String(recoveryError) }); }
    }
    throw error;
  } finally { if (heartbeat) clearInterval(heartbeat); await renewing; }
}
main().catch(async error => {
  const failure = { ok: false, code: error.code ?? "VALIDATION_FAILED", message: error.message };
  await progress("validation-process-ended", failure).catch(() => {});
  console.error(JSON.stringify(failure)); process.exitCode = 1;
});
