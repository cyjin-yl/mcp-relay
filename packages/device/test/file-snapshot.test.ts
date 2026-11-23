import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackContext } from "../src/pack.js";
import { createMinimalPack } from "../src/packs/minimal.js";
import { createOmpPack } from "../src/packs/omp.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
let root: string;
let ctx: PackContext;

beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), "relay-file-snapshot-"));
  ctx = { root, allowShell: false, allowKernel: false, fileState: new Map(), log: () => {} };
  vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync);
});

afterEach(() => {
  vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync);
  realFs.rmSync(root, { recursive: true, force: true });
});

// Deterministically reproduce a shell replacing the file immediately after
// the read returns its bytes, before the pack records the observed digest.
function replaceAfterRead(file: string, replacement: Buffer | string): void {
  let replaced = false;
  vi.mocked(fs.readFileSync).mockImplementation(((...args: unknown[]) => {
    const result = Reflect.apply(realFs.readFileSync, realFs, args);
    if (String(args[0]) === file && !replaced) {
      replaced = true;
      realFs.writeFileSync(file, replacement);
    }
    return result;
  }) as typeof fs.readFileSync);
}

describe("file observations under concurrent replacement", () => {
  for (const [name, factory, rendered] of [
    ["read", createMinimalPack, "before"],
    ["omp_read", createOmpPack, "1: before"]
  ] as const) {
    it(`${name} records the returned bytes and rejects a later stale edit`, async () => {
      const file = join(root, "observed.txt");
      realFs.writeFileSync(file, "before\n");
      replaceAfterRead(file, "after\n");

      const result = await factory().call(name, { path: "observed.txt" }, ctx);
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: rendered }]);
      expect(ctx.fileState?.get(file)).toBe(digest("before\n"));

      const edit = await createMinimalPack().call("edit", {
        path: "observed.txt", old_string: "after", new_string: "overwritten"
      }, ctx);
      expect(edit.isError).toBe(true);
      expect(JSON.stringify(edit.content)).toContain("file changed since it was read");
      expect(realFs.readFileSync(file, "utf8")).toBe("after\n");
    });
  }

  it("edit rejects a replacement between its snapshot and write", async () => {
    const file = join(root, "edit.txt");
    realFs.writeFileSync(file, "before\n");
    ctx.fileState?.set(file, digest("before\n"));
    replaceAfterRead(file, "external writer\n");

    const result = await createMinimalPack().call("edit", {
      path: "edit.txt", old_string: "before", new_string: "edited"
    }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("file changed while preparing the edit");
    expect(realFs.readFileSync(file, "utf8")).toBe("external writer\n");
  });

  it("omp_hash reports original non-UTF8 bytes without decoding and re-encoding", async () => {
    const file = join(root, "bytes.bin");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    realFs.writeFileSync(file, bytes);

    const result = await createOmpPack().call("omp_hash", { path: "bytes.bin" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ sha256: digest(bytes), bytes: bytes.length });
    expect(ctx.fileState?.get(file)).toBe(digest(bytes));
  });
});
