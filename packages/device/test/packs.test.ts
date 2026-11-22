import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMinimalPack } from "../src/packs/minimal.js";
import { createOmpPack } from "../src/packs/omp.js";
import type { PackContext } from "../src/pack.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-relay-pack-"));
  roots.push(root);
  return root;
}

function context(root: string): PackContext {
  return { root, allowShell: true, allowKernel: false, log: () => {} };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("minimal pack", () => {
  it("reads ranges and reports truncation", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "lines.txt"), "a\nb\nc\nd\n");
    const pack = createMinimalPack();
    const result = await pack.call("read", { path: "lines.txt", offset: 2, limit: 2 }, context(root));
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "text", text: "b\nc\n[truncated: 1 more lines]" });
  });

  it("rejects an ambiguous edit unless replace_all is set", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "x x x\n");
    const pack = createMinimalPack();
    await pack.call("read", { path: "a.txt" }, context(root));
    const failed = await pack.call("edit", { path: "a.txt", old_string: "x", new_string: "y" }, context(root));
    expect(failed.isError).toBe(true);
    const ok = await pack.call(
      "edit",
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      context(root)
    );
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("y y y\n");
  });

  it("runs bash and reports the exit code", async () => {
    const root = makeRoot();
    const pack = createMinimalPack();
    const ok = await pack.call("bash", { command: "printf hi" }, context(root));
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("exit_code: 0") });
    const bad = await pack.call("bash", { command: "exit 3" }, context(root));
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("exit_code: 3") });
  });

  it("lists and searches files", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.ts"), "export const needle = 1;\n");
    const pack = createMinimalPack();
    const found = await pack.call("find", { pattern: "*.ts" }, context(root));
    expect(found.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("a.ts") });
    const hits = await pack.call("grep", { pattern: "needle" }, context(root));
    expect(hits.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("a.ts:1") });
  });

  it("refuses paths outside the root", async () => {
    const root = makeRoot();
    const pack = createMinimalPack();
    const result = await pack.call("read", { path: "../outside.txt" }, context(root));
    expect(result.isError).toBe(true);
  });
});

describe("omp pack", () => {
  it("reads with a selector and hashes a file", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "a\nb\nc\n");
    const pack = createOmpPack();
    const read = await pack.call("omp_read", { path: "a.txt", selector: ":2-3" }, context(root));
    expect(read.content[0]).toMatchObject({ type: "text", text: "2: b\n3: c" });
    const hash = await pack.call("omp_hash", { path: "a.txt" }, context(root));
    const parsed = JSON.parse((hash.content[0] as { text: string }).text) as { sha256: string; bytes: number };
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.bytes).toBe(6);
  });

  it("applies a hash-anchored patch and refuses a stale hash", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    const pack = createOmpPack();
    const hash = JSON.parse(
      ((await pack.call("omp_hash", { path: "a.txt" }, context(root))).content[0] as { text: string }).text
    ) as { sha256: string };
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 one
-two
+2
*** End Patch`;
    const ok = await pack.call("omp_apply_patch", { patch, expected_hashes: { "a.txt": hash.sha256 } }, context(root));
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n2\n");
    const stale = await pack.call("omp_apply_patch", { patch, expected_hashes: { "a.txt": hash.sha256 } }, context(root));
    expect(stale.isError).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n2\n");
  });

  it("requires expected_hashes for an update patch", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\n");
    const pack = createOmpPack();
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-one
+two
*** End Patch`;
    const result = await pack.call("omp_apply_patch", { patch }, context(root));
    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("uses an ast-grep binary when present", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "sample.js"), "console.log(x);\n");
    const bin = join(root, "bin");
    mkdtempSync(bin);
    const fake = join(root, "ast-grep");
    writeFileSync(
      fake,
      `#!/bin/sh\ncat <<'EOF'\n[{"file":"sample.js","range":{"start":{"line":1}},"text":"console.log(x)"}]\nEOF\n`
    );
    chmodSync(fake, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${root}:${oldPath ?? ""}`;
    try {
      const pack = createOmpPack();
      const result = await pack.call("omp_ast_grep", { pattern: "console.log($A)", lang: "js" }, context(root));
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("sample.js:2") });
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
