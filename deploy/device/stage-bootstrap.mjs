#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  bundle: { type: "string" }, sha256: { type: "string" }, "base-version": { type: "string" },
  out: { type: "string" }, "manifest-url": { type: "string" },
  "android-launcher": { type: "string" }, "linux-launcher": { type: "string" },
  "linux-state": { type: "string" }, help: { type: "boolean" }
} });
if (values.help) {
  console.log("node deploy/device/stage-bootstrap.mjs --bundle <validated-cli.cjs> --sha256 <expected-final-sha256> --base-version 0.1.7 --out <new-stage-directory> [--android-launcher <observed-snapshot>] [--linux-launcher <snapshot> --linux-state <observed-json>]");
  process.exit(0);
}
if (!values.bundle || !values.sha256 || !values["base-version"] || !values.out) throw new Error("bundle, sha256, base-version and out are required");
if (!/^[a-f0-9]{64}$/i.test(values.sha256)) throw new Error("sha256 must be a full SHA-256 digest");
const baseVersion = values["base-version"];
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(baseVersion)) throw new Error("base-version must be a stable version");
const bootstrapVersion = baseVersion + "-bootstrap.1";
const manifest = new URL(values["manifest-url"] ?? "https://relay.cyjin.dev/updates/device/stable.json");
if (manifest.protocol !== "https:" || manifest.username || manifest.password || manifest.hash) throw new Error("manifest-url must be HTTPS without user information or fragments");
const finalPath = resolve(values.bundle);
const out = resolve(values.out);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const finalBytes = readFileSync(finalPath);
const expectedHash = values.sha256.toLowerCase();
if (sha256(finalBytes) !== expectedHash) throw new Error("final bundle does not match the reviewed SHA-256");
const before = "var VERSION = " + JSON.stringify(baseVersion) + ";";
const after = "var VERSION = " + JSON.stringify(bootstrapVersion) + ";";
const finalText = finalBytes.toString("utf8");
if (finalText.split(before).length !== 2) throw new Error("expected exactly one unminified CLI VERSION constant");
const bootstrapBytes = Buffer.from(finalText.replace(before, after), "utf8");
if (!Buffer.from(bootstrapBytes.toString("utf8").replace(after, before), "utf8").equals(finalBytes)) throw new Error("bootstrap would change bytes beyond the VERSION constant");
mkdirSync(out, { recursive: true, mode: 0o755 });
const files = {};
function keepFile(name, bytes, mode = 0o644, record = true) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const path = join(out, name);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(data)) throw new Error("existing staged file differs: " + name + "; use a new stage directory");
  } else writeFileSync(path, data, { flag: "wx", mode });
  if (record) files[name] = { bytes: data.length, sha256: sha256(data) };
  return path;
}
const bootstrapPath = keepFile("launcher.cjs", bootstrapBytes, 0o755);
execFileSync(process.execPath, ["--check", bootstrapPath], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
const reported = execFileSync(process.execPath, [bootstrapPath, "--version"], { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (reported !== bootstrapVersion) throw new Error("bootstrap CLI version check failed");
const quoteShell = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
if (values["android-launcher"]) {
  const original = readFileSync(resolve(values["android-launcher"]), "utf8");
  const oldEntry = 'node "$HOME/.local/share/mcp-relay-0.1.6/node_modules/@cyjin/mcp-relay/dist/cli.cjs"';
  const newEntry = 'node "$HOME/.local/share/mcp-relay/launcher.cjs"';
  const oldTail = ' --packs minimal,omp 2>&1 | tee -a "$HOME/.mcp-relay/relay.log"';
  const newTail = " --packs minimal,omp --update-manifest " + quoteShell(manifest.href) + ' --update-interval 300 2>&1 | tee -a "$HOME/.mcp-relay/relay.log"';
  if (original.split(oldEntry).length !== 2 || original.split(oldTail).length !== 2) throw new Error("Android snapshot differs from the observed launcher; inspect the live script before adapting it");
  const updated = original.replace(oldEntry, newEntry).replace(oldTail, newTail);
  if (original.split("while true; do")[0] !== updated.split("while true; do")[0]) throw new Error("Android environment recovery prefix changed");
  keepFile("android-run.original.sh", original, 0o755);
  keepFile("run-tablet.updated.sh", updated, 0o755);
}
if (Boolean(values["linux-state"]) !== Boolean(values["linux-launcher"])) throw new Error("linux-state and linux-launcher must be supplied together");
if (values["linux-state"]) {
  const metadata = JSON.parse(readFileSync(resolve(values["linux-state"]), "utf8"));
  const original = readFileSync(resolve(values["linux-launcher"]));
  if (sha256(original) !== metadata.legacyLauncherSha256) throw new Error("Linux launcher snapshot digest differs from its observation");
  const allowed = new Set(["PATH", "SHELL", "LANG", "LC_ALL", "MCP_RELAY_BASH", "PREFIX"]);
  const lines = [];
  for (const [key, value] of Object.entries(metadata.runtimeEnvironment ?? {})) {
    if (!allowed.has(key) || typeof value !== "string" || /[\0\r\n]/.test(value)) throw new Error("unexpected runtime environment entry");
    lines.push(key + '="' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
  }
  keepFile("doesvm-service.env", lines.join("\n") + "\n");
  keepFile("doesvm-run.original.sh", original, 0o755);
  keepFile("doesvm-before.json", JSON.stringify(metadata, null, 2) + "\n");
  const templates = dirname(fileURLToPath(import.meta.url));
  for (const name of ["mcp-relay-doesvm.service", "rollback-doesvm.py"]) {
    let body = readFileSync(join(templates, name), "utf8");
    if (name === "mcp-relay-doesvm.service") {
      const systemdUrl = '"' + manifest.href.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      body = body.replace("https://relay.cyjin.dev/updates/device/stable.json", systemdUrl);
    }
    keepFile(name, body, name.endsWith(".py") ? 0o755 : 0o644);
  }
}
if (sha256(readFileSync(finalPath)) !== expectedHash) throw new Error("final bundle changed during staging");
const receipt = {
  schemaVersion: 1, baseVersion, baseSha256: expectedHash, baseBytes: finalBytes.length,
  bootstrapVersion, bootstrapSha256: sha256(bootstrapBytes), bootstrapBytes: bootstrapBytes.length,
  change: "only the CLI VERSION constant differs from the validated final bundle",
  runtime: process.version, manifestUrl: manifest.href, files
};
keepFile("bootstrap-provenance.json", JSON.stringify(receipt, null, 2) + "\n", 0o644, false);
console.log(JSON.stringify(receipt, null, 2));
