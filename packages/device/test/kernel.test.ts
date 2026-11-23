import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKernelPack } from "../src/packs/kernel.js";
import type { PackContext } from "../src/pack.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-relay-kernel-"));
  roots.push(root);
  return root;
}

function context(root: string): PackContext {
  return { root, allowShell: false, allowKernel: true, log: () => {} };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent kernel pack", () => {
  it("keeps state across calls and resets explicitly", async () => {
    const root = makeRoot();
    const pack = createKernelPack();
    const first = await pack.call("kernel_eval", { code: "globalThis.n = (globalThis.n ?? 0) + 1; n" }, context(root));
    expect(first.isError).toBeFalsy();
    expect(first.content[0]).toMatchObject({ text: "=> 1" });
    const second = await pack.call("kernel_eval", { code: "n += 1; n" }, context(root));
    expect(second.content[0]).toMatchObject({ text: "=> 2" });
    const reset = await pack.call("kernel_reset", {}, context(root));
    expect(reset.isError).toBeFalsy();
    const after = await pack.call("kernel_eval", { code: "typeof n" }, context(root));
    expect(after.content[0]).toMatchObject({ text: "=> 'undefined'" });
  });

  it("returns console output and supports root-confined fs helpers", async () => {
    const root = makeRoot();
    const pack = createKernelPack();
    const result = await pack.call(
      "kernel_eval",
      { code: "console.log('hello'); relay.writeFile('x.txt', 'body'); relay.readFile('x.txt')" },
      context(root)
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("hello");
    expect(text).toContain("=> 'body'");
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("body");
    const escape = await pack.call("kernel_eval", { code: "relay.readFile('../outside')" }, context(root));
    expect(escape.isError).toBe(true);
  });

  it("enforces a CPU timeout", async () => {
    const root = makeRoot();
    const pack = createKernelPack();
    const result = await pack.call("kernel_eval", { code: "while (true) {}", timeout_ms: 50 }, context(root));
    expect(result.isError).toBe(true);
  });
});
