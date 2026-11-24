import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  androidFocusGuardScript, androidFocusRecheckScript, parseAndroidFocusFailure, normalizeAndroidAppId
} from "../src/computer/android.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/android-default-focus.json", import.meta.url), "utf8")) as {
  displays: string; windows: string; sourceSha256: string;
};
const own = "dev.cyjin.mcprelay.input/.ProbeActivity";
const nonce = "a".repeat(32);
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const other = fixture.displays.replaceAll("dev.cyjin.mcprelay.input", "com.example.other");

// Execute the production shell itself, with only native command locations replaced by
// finite local fixture readers. This sends no device input and never invokes su.
function runGate(snapshots: string[], postIme = false) {
  const directory = mkdtempSync(join(tmpdir(), "relay-focus-gate-"));
  const counter = join(directory, "count");
  snapshots.forEach((data, i) => writeFileSync(join(directory, "snapshot-" + i), data));
  const reader = join(directory, "read-snapshot.sh");
  const cases = snapshots.map((_data, i) => String(i + 1) + ") cat " + quote(join(directory, "snapshot-" + i)) + " ;;").join("\n");
  writeFileSync(reader, [
    "n=0", "if [ -f " + quote(counter) + " ]; then read -r n < " + quote(counter) + "; fi",
    "n=$((n + 1))", "printf '%s\\n' \"$n\" > " + quote(counter),
    "case \"$n\" in", cases, "*) cat " + quote(join(directory, "snapshot-" + (snapshots.length - 1))) + " ;;", "esac", ""
  ].join("\n"));
  const suffix = postIme
    ? "trap 'printf \"RESTORED\\n\"' EXIT\nprintf 'IME_CHANGED\\n'\n" + androidFocusRecheckScript(nonce) + "printf 'COMMIT_SENT\\n'\n"
    : "printf 'INPUT_SENT\\n'\n";
  const script = (androidFocusGuardScript(own, nonce) + suffix)
    .replaceAll("/system/bin/dumpsys window displays", "/bin/sh " + quote(reader))
    .replaceAll("/system/bin/sed", "/bin/sed");
  writeFileSync(join(directory, "generated.sh"), script);
  const result = spawnSync("/bin/sh", ["-s"], { input: script, encoding: "utf8", timeout: 4000, maxBuffer: 64 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  return { ...result, observations: Number(readFileSync(counter, "utf8")) };
}

describe.skipIf(process.platform === "win32")("Android final-root foreground gate", () => {
  it("uses the observed equal-indent default fields and normalizes short/full component names", () => {
    expect(fixture.sourceSha256).toBe("60408aa685457e147f8c39fadebfcdd561fd813237eccf93adb298ebadc5501c");
    expect(fixture.displays).toContain("  Display: mDisplayId=0\n  mCurrentFocus=");
    expect(normalizeAndroidAppId(own)).toBe("dev.cyjin.mcprelay.input/dev.cyjin.mcprelay.input.ProbeActivity");
    const result = runGate([fixture.displays]);
    expect(result.status).toBe(0); expect(result.observations).toBe(2);
    expect(result.stdout).toBe("INPUT_SENT\n");
  });
  it("allows a transient different app only after two later completed target snapshots", () => {
    const result = runGate([other, fixture.displays, fixture.displays]);
    expect(result.status).toBe(0); expect(result.observations).toBe(3);
    expect(result.stdout).toBe("INPUT_SENT\n");
  });
  it.each([
    ["other", other, "changed"],
    ["unknown", "  Display: mDisplayId=0\n  mCurrentFocus=null\n", "unknown"],
    ["external-only", fixture.displays.replace("mDisplayId=0", "mDisplayId=2"), "unknown"],
    ["conflict", fixture.displays.replace("dev.cyjin.mcprelay.input/.ProbeActivity", "com.example.other/.Other"), "unknown"],
    ["duplicate-default", fixture.displays + fixture.displays, "unknown"]
  ])("bounds persistent %s to four read-only snapshots without input", (_name, snapshot, reason) => {
    const result = runGate([snapshot!]);
    expect(result.status).toBe(73); expect(result.observations).toBe(4);
    expect(result.stdout).not.toMatch(/INPUT_SENT|IME_CHANGED|COMMIT_SENT|com\.example\.other/);
    expect(parseAndroidFocusFailure(result.stdout, nonce, result.status!)).toEqual({ phase: "preflight", reason });
  });
  it("never combines nonconsecutive target observations into permission to input", () => {
    const result = runGate([fixture.displays, other, fixture.displays, other]);
    expect(result.status).toBe(73); expect(result.observations).toBe(4);
    expect(result.stdout).not.toContain("INPUT_SENT");
  });
  it("does not let an external display or a later global window block provide default focus", () => {
    const external = fixture.displays.replace("mDisplayId=0", "mDisplayId=7");
    const defaultMissing = "  Display: mDisplayId=0\n  init=1200x2000\n";
    const global = "\nWINDOW MANAGER WINDOWS\n" + fixture.displays.split("\n").slice(1).join("\n");
    const result = runGate([external + defaultMissing + global]);
    expect(result.status).toBe(73); expect(result.stdout).not.toContain("INPUT_SENT");
  });
  it("restores after IME mutation and sends zero commits if the final fresh snapshot changes", () => {
    const result = runGate([fixture.displays, fixture.displays, other], true);
    expect(result.status).toBe(74); expect(result.observations).toBe(3);
    expect(result.stdout).toContain("IME_CHANGED\n");
    expect(result.stdout).toContain("RESTORED\n");
    expect(result.stdout).not.toContain("COMMIT_SENT");
    expect(parseAndroidFocusFailure(result.stdout, nonce, result.status!)).toEqual({ phase: "input_method", reason: "changed" });
  });
  it("does not trust another request's refusal or a mismatched exit phase", () => {
    const result = runGate([other]);
    expect(parseAndroidFocusFailure(result.stdout, "b".repeat(32), 73)).toBeUndefined();
    expect(parseAndroidFocusFailure(result.stdout, nonce, 74)).toBeUndefined();
  });
});
