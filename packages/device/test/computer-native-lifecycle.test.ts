import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args);
      observed.child = child;
      return child;
    },
  };
});
import { runNative } from "../src/computer/native.js";

describe("native process lifecycle ownership", () => {
  it("does not treat an error from a live helper as process exit", async () => {
    const result = runNative({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }, { timeoutMs: 5000 });
    const checked = expect(result).rejects.toMatchObject({
      code: "native_process_failed",
      details: { cause: "EPERM", mayHaveApplied: true },
    });
    const child = observed.child!;
    let realExit = false;
    child.once("exit", () => { realExit = true; });
    try {
      await once(child, "spawn");
      // Node emits this event for failed signals as well as failed spawn.
      // Keep a real owned process alive to verify the result waits for exit.
      child.emit("error", Object.assign(new Error("simulated signal failure"), { code: "EPERM" }));
      child.emit("error", Object.assign(new Error("repeated signal failure"), { code: "EPERM" }));
      await checked;
      expect(realExit).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("reports a missing executable without inventing a live process", async () => {
    await expect(runNative({
      command: "/definitely-missing-relay-native-helper-831f3722823f",
      args: [],
    }, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "native_spawn_failed",
      details: { cause: "ENOENT", mayHaveApplied: false },
    });
  });
});
