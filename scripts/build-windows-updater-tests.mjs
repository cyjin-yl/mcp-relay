import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] ?? "release/windows-updater-smoke.cjs");
const fixtureSource = "packages/device/test/manual/windows-updater-fixture.ts";
const fixtures = {};
for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [fixtureSource],
    platform: "node", format: "cjs", target: "node22", bundle: true, write: false,
    define: { FIXTURE_VERSION: JSON.stringify(version) }
  });
  fixtures[version] = result.outputFiles[0].text;
}
mkdirSync(dirname(output), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["packages/device/test/manual/windows-updater-smoke.ts"],
  platform: "node", format: "cjs", target: "node22", bundle: true, outfile: output,
  define: { RELAY_UPDATER_FIXTURES: JSON.stringify(fixtures) }
});
const bytes = readFileSync(output);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(output + ".sha256", sha256 + "  " + output.split(/[\\/]/).pop() + "\n");
process.stdout.write(JSON.stringify({ output, sha256, bytes: bytes.length }) + "\n");
