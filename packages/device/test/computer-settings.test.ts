import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerSettingsPath, readComputerSettings, writeComputerSettings } from "../src/computer/settings.js";

function config() {
  const path = join(mkdtempSync(join(tmpdir(), "relay-computer-settings-")), "device.json");
  writeFileSync(path, '{"token":"fixture-not-a-credential"}', { mode: 0o600 });
  return path;
}
describe("computer configuration generations", () => {
  it("keeps no-op enable idempotent but distinguishes disable then enable from the old request", () => {
    const path = config();
    expect(readComputerSettings(path).enabled).toBe(false);
    const first = writeComputerSettings(path, { enabled: true });
    expect(first.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(writeComputerSettings(path, { enabled: true }).revision).toBe(first.revision);
    const disabled = writeComputerSettings(path, { enabled: false });
    const restored = writeComputerSettings(path, { enabled: true });
    expect(disabled.revision).not.toBe(first.revision);
    expect(restored.revision).not.toBe(first.revision);
    expect(restored.revision).not.toBe(disabled.revision);
  });
  it("preserves pause and credential bytes while keeping settings private", () => {
    const path = config(), original = readFileSync(path);
    writeComputerSettings(path, { paused: true });
    const enabled = writeComputerSettings(path, { enabled: true });
    expect(enabled.paused).toBe(true);
    expect(readFileSync(path)).toEqual(original);
    if (process.platform !== "win32") expect(statSync(computerSettingsPath(path)).mode & 0o777).toBe(0o600);
  });
  it("does not expose foreign fields and fails closed on an invalid revision", () => {
    const path = config();
    writeFileSync(computerSettingsPath(path), JSON.stringify({ schema: 1, enabled: true, paused: false, foreignSecret: "fixture" }));
    expect(readComputerSettings(path)).not.toHaveProperty("foreignSecret");
    writeFileSync(computerSettingsPath(path), JSON.stringify({ schema: 1, enabled: true, paused: false, revision: "invalid" }));
    expect(() => readComputerSettings(path)).toThrow("settings are invalid");
  });
});
