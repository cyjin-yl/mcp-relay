import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("release", { recursive: true });
await build({ entryPoints: ["packages/device/test/manual/linux-workspace-smoke.ts"], bundle: true,
  platform: "node", target: "node22", format: "cjs", outfile: "release/linux-workspace-smoke.cjs", sourcemap: false });
