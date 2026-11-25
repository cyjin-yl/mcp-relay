import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const shimSource = fileURLToPath(new URL("../bin/mcp-relay.cjs", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const probe = [
  'process.stdout.write(JSON.stringify({',
  'argv: process.argv, filename: __filename, execArgv: process.execArgv,',
  'sentinel: process.env.RELAY_NPM_TEST_SENTINEL, pid: process.pid',
  '}) + "\\n");'
].join("\n");
function fixture(bundle = probe) {
  const root = mkdtempSync(join(tmpdir(), "relay npm 空间-"));
  temporary.push(root);
  const packageRoot = join(root, "package 包");
  const shim = join(packageRoot, "bin", "mcp-relay.cjs");
  const cli = join(packageRoot, "dist", "cli.cjs");
  mkdirSync(dirname(shim), { recursive: true });
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(shimSource, shim);
  writeFileSync(cli, bundle);
  writeFileSync(join(packageRoot, "package.json"), '{"type":"module"}\n');
  return { root, packageRoot, shim, cli };
}
function run(entry: string, args: string[] = [], nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, entry, ...args], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, RELAY_NPM_TEST_SENTINEL: "environment stays 原样" }
  });
}
function npmLink(f: ReturnType<typeof fixture>) {
  const middle = join(f.root, "relative intermediate");
  const entry = join(f.root, ".bin 空间", "mcp-relay");
  mkdirSync(dirname(entry));
  symlinkSync(relative(dirname(middle), f.shim), middle);
  symlinkSync(relative(dirname(entry), middle), entry);
  return entry;
}
const symlinkTest = it.skipIf(process.platform === "win32");

describe("npm bundle entry shim", () => {
  it("publishes the shim as bin while main still points to the standalone bundle", () => {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(metadata.main).toBe("./dist/cli.cjs");
    expect(metadata.bin).toEqual({ "mcp-relay": "./bin/mcp-relay.cjs" });
    expect(metadata.files).toContain("bin/mcp-relay.cjs");
    expect(metadata.files).toContain("dist/cli.cjs");
  });

  it("loads the actual CommonJS bundle from a package declared as ESM", () => {
    const f = fixture();
    const child = run(f.shim, ["--version"]);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      argv: [process.execPath, f.cli, "--version"], filename: f.cli
    });
  });

  symlinkTest.each([
    { nodeArgs: [] },
    { nodeArgs: ["--preserve-symlinks-main"] },
    { nodeArgs: ["--preserve-symlinks", "--preserve-symlinks-main"] }
  ])("resolves multiple relative extensionless links with Node options $nodeArgs", ({ nodeArgs }) => {
    const f = fixture();
    const child = run(npmLink(f), ["connect", "--name=--keep", "--root", "目录 with spaces"], nodeArgs);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      argv: [process.execPath, f.cli, "connect", "--name=--keep", "--root", "目录 with spaces"],
      filename: f.cli, execArgv: nodeArgs
    });
  });

  symlinkTest("canonicalizes the bundle itself before handing its filename to the updater", () => {
    const f = fixture();
    const actual = join(f.root, "canonical runtime.cjs");
    renameSync(f.cli, actual);
    symlinkSync(relative(dirname(f.cli), actual), f.cli);
    const child = run(npmLink(f), ["connect"], ["--preserve-symlinks-main"]);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      argv: [process.execPath, actual, "connect"], filename: actual
    });
  });

  it("preserves empty, quoted, Unicode and option-shaped arguments plus environment and execArgv", () => {
    const f = fixture();
    const args = ["", "two words", "引号'\"", "--", "--name=--x", "$literal", "\\backslash"];
    const child = run(f.shim, args, ["--stack-trace-limit=17"]);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      argv: [process.execPath, f.cli, ...args], execArgv: ["--stack-trace-limit=17"],
      sentinel: "environment stays 原样"
    });
    expect(JSON.parse(child.stdout).pid).toBe(child.pid);
  });

  it("preserves bundle stdout, stderr and its nonzero exit code", () => {
    const f = fixture('process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = 23;\n');
    const child = run(f.shim);
    expect(child.status).toBe(23);
    expect(child.stdout).toBe("out\n");
    expect(child.stderr).toBe("err\n");
  });

  it("preserves a bundle exception", () => {
    const f = fixture('throw new Error("bundle-sentinel-failure");\n');
    const child = run(f.shim);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("bundle-sentinel-failure");
  });

  it("fails without starting a replacement when the bundle is absent", () => {
    const f = fixture();
    rmSync(f.cli);
    const child = run(f.shim);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("ENOENT");
  });

  it.skipIf(process.platform === "win32")("leaves signal handling in the same bundle process", async () => {
    const f = fixture('process.on("SIGTERM", () => process.exit(43)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [f.shim], { stdio: ["ignore", "pipe", "pipe"] });
    const completed = once(child, "exit");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await once(child.stdout!, "data");
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await completed).toEqual([43, null]);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
