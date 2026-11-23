import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { runShell, shellEnvironment } from "../src/shell.js";

afterEach(() => vi.unstubAllEnvs());

it("restores only Android's required runtime paths while filtering credentials", () => {
  const keys = ["ANDROID_DATA", "ANDROID_ROOT", "ANDROID_RUNTIME_ROOT", "ANDROID_ART_ROOT",
    "ANDROID_I18N_ROOT", "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH", "DEX2OATBOOTCLASSPATH"];
  for (const key of keys) vi.stubEnv(key, `/system/test/${key}`);
  vi.stubEnv("NPM_TOKEN", "test-token-do-not-forward");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-do-not-forward");
  vi.stubEnv("LD_PRELOAD", "/untrusted/library.so");
  const android = shellEnvironment("android");
  for (const key of keys) expect(android[key]).toBe(`/system/test/${key}`);
  expect(android.NPM_TOKEN).toBeUndefined();
  expect(android.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(android.LD_PRELOAD).toBeUndefined();
  expect(shellEnvironment("linux").ANDROID_DATA).toBeUndefined();
});

it("kills a running shell process group on cancellation before its delayed side effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-shell-cancel-"));
  const controller = new AbortController();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    const trigger = join(root, "trigger");
    const running = runShell(root, `(while [ ! -f ${quote(trigger)} ]; do sleep 0.01; done; printf late > ${quote(join(root, "late"))}) & printf ready > ${quote(join(root, "ready"))}; wait`, undefined, 10000, controller.signal);
    for (let count = 0; count < 1000 && !existsSync(join(root, "ready")); count++) await delay(5);
    expect(existsSync(join(root, "ready"))).toBe(true);
    controller.abort(new Error("test cancellation"));
    const result = await running;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    // Release the child's guard only after cancellation has reaped the group.
    // A surviving background child would now write the forbidden marker.
    writeFileSync(trigger, "go");
    await delay(100);
    expect(existsSync(join(root, "late"))).toBe(false);
    const before = new AbortController();
    before.abort();
    expect(() => runShell(root, "printf bad > never", undefined, 1000, before.signal)).toThrow();
    expect(existsSync(join(root, "never"))).toBe(false);
  } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
}, 10000);

it("executes without implicit login profiles while retaining the explicit PATH and cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-shell-profile-"));
  vi.stubEnv("HOME", root);
  writeFileSync(join(root, ".bash_profile"), "printf profile-hook; exit 17\n");
  try {
    const result = await runShell(root, "if shopt -q login_shell; then exit 19; fi; command -v bash >/dev/null; printf '%s|%s' \"$MCP_RELAY\" \"$PWD\"", undefined, 2000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`1|${root}`);
    expect(result.stderr).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("finds Android bash in the Termux prefix without LD_PRELOAD path rewriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-termux-shell-"));
  const bin = join(root, "termux", "usr", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bash"), "#!/bin/sh\nprintf 'termux-bash\\n'\nexec /bin/bash \"$@\"\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("LD_PRELOAD", "/untrusted/exec-rewrite.so");
  try {
    const result = await runShell(root, "printf 'command-ok|%s' \"${LD_PRELOAD-unset}\"", undefined, 2000, undefined, "android");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("termux-bash\ncommand-ok|unset");
    expect(result.stderr).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
