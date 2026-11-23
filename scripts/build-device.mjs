import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "packages/device/dist/cli.cjs");
await build({
  absWorkingDir: root,
  entryPoints: ["packages/device/src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["bufferutil", "utf-8-validate"],
  outfile: output,
  banner: { js: "// Standalone relay client; ws and all required runtime dependencies are bundled." }
});
const bytes = readFileSync(output);
const version = JSON.parse(readFileSync(resolve(root, "packages/device/package.json"), "utf8")).version;
const sha256 = createHash("sha256").update(bytes).digest("hex");
const release = resolve(root, "release/device", version);
mkdirSync(release, { recursive: true });
writeFileSync(resolve(release, "cli.cjs"), bytes);
writeFileSync(resolve(release, "cli.cjs.sha256"), `${sha256}  cli.cjs\n`);
const manifest = {
  schemaVersion: 1, version,
  url: `https://relay.cyjin.dev/updates/device/${version}/cli.cjs`,
  sha256, minNodeVersion: "22.5.0"
};
writeFileSync(resolve(root, "release/device/stable.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ version, sha256, bytes: bytes.length, output, release })}\n`);
