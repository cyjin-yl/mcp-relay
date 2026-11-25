import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAndroidWorkspaceProvider } from "../../src/computer/workspace-android.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext, WorkspaceResource } from "../../src/computer/workspace-types.js";

const PACKAGE = "dev.cyjin.mcprelay.workspaceprobe";
const root = join(homedir(), ".mcp-relay", "workspace-provider-smoke", randomUUID());
const journalDirectory = join(root, "lease");
const revocationPath = join(journalDirectory, "revoked.json");
const run = (command: string) => execFileSync("su", ["-c", command], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
function physicalMetadata() {
  const window = run("/system/bin/dumpsys window");
  return { focusedDisplay: window.match(/mTopFocusedDisplayId=(\d+)/)?.[1],
    ime: run("/system/bin/settings get secure default_input_method").trim(),
    enabledImes: run("/system/bin/settings get secure enabled_input_methods").trim() };
}
async function main() {
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const provider = createAndroidWorkspaceProvider({ home: root });
  const checkpoints: WorkspaceResource[] = [];
  const context: WorkspaceProviderContext = { journalDirectory, revocationPath, timeoutMs: 10000,
    checkpoint: async resource => { checkpoints.push(structuredClone(resource)); await writeFile(join(journalDirectory, "resource.json"), JSON.stringify(resource), { mode: 0o600 }); } };
  const prior = await provider.probe(context);
  assert.equal(prior.available, false);
  assert.match(prior.reason ?? "", /computer_setup/);
  await provider.setup!(context);
  const capabilities = await provider.probe(context);
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.clipboardBoundary, "shared-app-state");
  assert.equal(capabilities.unicodeText, false);
  run("/system/bin/am force-stop " + PACKAGE);
  const baseline = physicalMetadata();
  const options: WorkspaceOpenOptions = { leaseId: randomUUID(), width: 640, height: 480,
    expiresAt: Date.now() + 30_000, hardExpiresAt: Date.now() + 60_000,
    launch: { executable: PACKAGE + "/.ProbeActivity", args: [] } };
  let resource: WorkspaceResource | undefined;
  const report: Record<string, unknown> = { capabilities, baseline };
  try {
    resource = await provider.open(options, context);
    report.resource = resource;
    assert.equal(checkpoints[0]?.data.phase, "intent");
    const state = await provider.inspect(resource, context);
    assert.equal(state.app?.id, PACKAGE);
    assert.equal(state.displays[0]?.instanceId, resource.display.instanceId);
    await provider.act(resource, { type: "text", text: "Provider42" }, { ...context, expectedAppId: PACKAGE });
    await assert.rejects(provider.act(resource, { type: "text", text: "not-applied" }, { ...context, expectedAppId: "wrong.application" }), /foreground application changed/);
    await assert.rejects(provider.act(resource, { type: "text", text: "\u4e2d\u6587" }, context), /ASCII/);
    const capture = await provider.capture(resource, context);
    assert.equal(capture.app?.id, PACKAGE);
    assert.equal(capture.display.instanceId, resource.display.instanceId);
    assert.equal(capture.data.readUInt32BE(16), 640);
    await writeFile(join(root, "private.png"), capture.data);
    report.capture = { bytes: capture.data.length, appId: capture.app?.id, display: capture.display };
    await provider.renew(resource, options.expiresAt, context);
    assert.deepEqual(physicalMetadata(), baseline);
    const dataDir = run("/system/bin/dumpsys package " + PACKAGE).match(/dataDir=(\S+)/)?.[1];
    assert.ok(dataDir && /^[/A-Za-z0-9_.-]+$/.test(dataDir));
    const input = JSON.parse(run("/system/bin/cat " + dataDir + "/files/probe.json"));
    assert.equal(input.text, "Provider42");
    assert.equal("android-workspace:" + input.displayId, resource.display.id);
    report.privateInput = input;
    await writeFile(revocationPath, JSON.stringify({ schema: 1, leaseId: options.leaseId, reason: "explicit", revokedAt: Date.now() }), { mode: 0o600 });
    const recovery = await provider.recover(resource, options, "explicit", context);
    assert.equal(recovery.complete, true);
    assert.equal(recovery.ownedDisplayRemoved, true);
    report.recovery = recovery;
    const migrated = JSON.parse(run("/system/bin/cat " + dataDir + "/files/probe.json"));
    assert.equal(migrated.displayId, 0);
    assert.equal(migrated.taskId, input.taskId);
    assert.equal(migrated.text, "Provider42");
    report.migrated = migrated;
    const secondRecovery = await provider.recover(resource, options, "recovery", context);
    assert.equal(secondRecovery.complete, true);
    report.idempotentRecovery = secondRecovery;
    report.passed = true;
  } finally {
    await provider.recover(resource ?? checkpoints.at(-1), options, "recovery", context);
    run("/system/bin/am force-stop " + PACKAGE);
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ ...report, evidence: root }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
