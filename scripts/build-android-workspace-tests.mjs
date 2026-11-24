#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const output = root + "release/android-workspace-provider-smoke.cjs";
await mkdir(root + "release", { recursive: true });
await build({ entryPoints: [root + "packages/device/test/manual/android-workspace-provider-smoke.ts"],
  bundle: true, platform: "node", target: "node22", format: "cjs", outfile: output, sourcemap: false });
const bytes = await readFile(output);
console.log(JSON.stringify({ artifact: output, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }));
