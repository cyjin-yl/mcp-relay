import { expect, it } from "vitest";
import { createKernelPack } from "../src/packs/kernel.js";

it("protects kernel session state from automatic replacement until explicitly reset", async () => {
  const pack = createKernelPack();
  const ctx = { root: process.cwd(), allowShell: false, allowKernel: true, log() {} };
  expect(pack.updateBlockedReason?.()).toBeUndefined();
  await pack.call("kernel_eval", { code: "globalThis.saved = 42" }, ctx);
  expect(pack.updateBlockedReason?.()).toMatch(/kernel_reset/);
  await pack.call("kernel_reset", {}, ctx);
  expect(pack.updateBlockedReason?.()).toBeUndefined();
  await pack.call("kernel_eval", { code: "globalThis.partiallySaved = 1; throw new Error('after write')" }, ctx);
  expect(pack.updateBlockedReason?.()).toMatch(/kernel_reset/);
});
