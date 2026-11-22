import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/patch.js";
import { createMinimalPack } from "../src/packs/minimal.js";
import type { PackContext } from "../src/pack.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-relay-hardening-"));
  roots.push(root);
  return root;
}

function context(root: string): PackContext {
  return { root, allowShell: false, allowKernel: false, log: () => {} };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("glob containment", () => {
  it("rejects find patterns with parent segments", async () => {
    const root = makeRoot();
    const result = await createMinimalPack().call("find", { pattern: "../**/*" }, context(root));
    expect(result.isError).toBe(true);
  });

  it("rejects grep glob patterns with parent segments", async () => {
    const root = makeRoot();
    const result = await createMinimalPack().call("grep", { pattern: "x", glob: "../**/*" }, context(root));
    expect(result.isError).toBe(true);
  });
});

describe("patch duplicate paths", () => {
  it("rejects two sections touching the same file", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-one",
      "+two",
      "*** Update File: a.txt",
      "@@",
      "-two",
      "+three",
      "*** End Patch"
    ].join("\n");
    expect(() => applyPatch(root, patch)).toThrow(/duplicate/);
  });
});
