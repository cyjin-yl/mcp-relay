import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("release", { recursive: true });
await build({
  entryPoints: ["packages/device/test/manual/wayland-portal-smoke.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "release/wayland-portal-smoke.cjs",
  sourcemap: false,
});
