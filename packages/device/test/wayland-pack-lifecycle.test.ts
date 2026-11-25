import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createComputerPack } from "../src/packs/computer.js";
import type { ComputerBackend, ComputerState } from "../src/computer/types.js";
import type { ComputerSettings } from "../src/computer/settings.js";
import type { PackContext } from "../src/pack.js";

const context: PackContext = { root: "/", allowShell: false, allowKernel: false, log: () => {} };
function fixture() {
  let settings: ComputerSettings = { schema: 1, enabled: true, paused: false, revision: "initial" };
  const state: ComputerState = { platform: "linux", backend: "linux-wayland-portal", available: false,
    displayKind: "none", inputKind: "none", displays: [], actions: [], unicodeText: false, permissions: {} };
  const close = vi.fn(async () => {});
  const setup = vi.fn(async () => ({ state }));
  const backend: ComputerBackend = { id: "linux-wayland-portal", setupInWorker: true, close, setup,
    inspect: async () => state, act: async () => ({}), screenshot: async () => { throw new Error("unused"); } };
  const pack = createComputerPack({ configPath: "/unused", backend, settings: () => settings,
    saveSettings: change => settings = { ...settings, ...change }, lock: async () => async () => {} });
  return { pack, close, setup, settings: () => settings,
    set: (change: Partial<ComputerSettings>) => { settings = { ...settings, ...change }; } };
}

describe("Wayland permission lifecycle in the computer pack", () => {
  it.each([{ paused: true }, { enabled: false }, { revision: "pause-and-resume" }])(
    "closes idle portal permissions when local settings change: %j", async change => {
      const f = fixture();
      try {
        await f.pack.call("computer_setup", {}, context);
        f.set(change);
        await vi.waitFor(() => expect(f.close).toHaveBeenCalled(), { timeout: 1000, interval: 20 });
      } finally { await f.pack.dispose?.(); }
    });

  it("cancels an in-flight consent prompt when the user pauses locally", async () => {
    const f = fixture();
    f.setup.mockImplementation(async () => {
      await delay(180);
      return { state: {} as ComputerState };
    });
    try {
      const setup = f.pack.call("computer_setup", {}, context);
      await delay(30);
      f.set({ paused: true, revision: "pause" });
      const result = await setup;
      expect(result.isError).toBe(true);
      expect(f.close).toHaveBeenCalled();
    } finally { await f.pack.dispose?.(); }
  });

  it("closes the permission session on disconnect, revocation, handoff and disposal", async () => {
    const f = fixture();
    await f.pack.call("computer_setup", {}, context);
    f.pack.connectionClosed?.("old-connection");
    expect(f.close).toHaveBeenCalledTimes(1);
    await f.pack.revokeWorkspaceOwner?.("share:expired");
    expect(f.close).toHaveBeenCalledTimes(2);
    await f.pack.call("computer_handoff", { mode: "pause" }, context);
    expect(f.close).toHaveBeenCalledTimes(3);
    await f.pack.dispose?.();
    expect(f.close).toHaveBeenCalledTimes(4);
  });

  it("never resumes after its deadline expires while old portal cleanup is pending", async () => {
    const f = fixture();
    try {
      await f.pack.call("computer_setup", {}, context);
      f.set({ paused: true, revision: "local-pause" });
      f.close.mockImplementation(async () => { await delay(150); });
      const result = await f.pack.call("computer_handoff", { mode: "resume", timeout_ms: 10 }, context);
      expect(result.isError).toBe(true);
      expect(f.settings().paused).toBe(true);
    } finally { await f.pack.dispose?.(); }
  });
});
