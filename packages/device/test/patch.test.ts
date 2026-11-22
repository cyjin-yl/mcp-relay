import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/patch.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-relay-patch-"));
  roots.push(root);
  return root;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("omp apply_patch", () => {
  it("adds a file with a trailing newline", () => {
    const root = makeRoot();
    const result = applyPatch(
      root,
      `*** Begin Patch
*** Add File: a.txt
+hello
+world
*** End Patch`
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello\nworld\n");
    expect(result[0]?.action).toBe("add");
  });

  it("updates a file when the base hash matches", () => {
    const root = makeRoot();
    const original = "hello\nworld\n";
    writeFileSync(join(root, "a.txt"), original);
    applyPatch(
      root,
      `*** Begin Patch
*** Update File: a.txt
@@
 hello
-world
+earth
*** End Patch`,
      { "a.txt": sha(original) }
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello\nearth\n");
  });

  it("refuses a hash mismatch without touching the file", () => {
    const root = makeRoot();
    const original = "hello\nworld\n";
    writeFileSync(join(root, "a.txt"), original);
    expect(() =>
      applyPatch(
        root,
        `*** Begin Patch
*** Update File: a.txt
@@
 hello
-world
+earth
*** End Patch`,
        { "a.txt": sha("something else") }
      )
    ).toThrow(/hash mismatch/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(original);
  });

  it("rejects ambiguous context", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "same\nsame\n");
    expect(() =>
      applyPatch(
        root,
        `*** Begin Patch
*** Update File: a.txt
@@
-same
+other
*** End Patch`
      )
    ).toThrow(/ambiguous/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("same\nsame\n");
  });

  it("deletes and moves files", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    applyPatch(
      root,
      `*** Begin Patch
*** Delete File: a.txt
*** Update File: b.txt
*** Move to: c.txt
@@
-b
+c
*** End Patch`
    );
    expect(() => readFileSync(join(root, "a.txt"))).toThrow();
    expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("c\n");
  });

  it("rejects traversal", () => {
    const root = makeRoot();
    expect(() =>
      applyPatch(
        root,
        `*** Begin Patch
*** Add File: ../escape.txt
+x
*** End Patch`
      )
    ).toThrow(/escapes root/);
  });
});
