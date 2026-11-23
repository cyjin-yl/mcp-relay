import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveShell, runShell, shellEnvironment } from "../src/shell.js";

afterEach(() => vi.unstubAllEnvs());

describe("shell resolution", () => {
  it("selects an executable bash/sh and matching arguments", () => {
    if (process.platform === "win32") return;
    const shell = resolveShell();
    expect(shell.path.startsWith("/")).toBe(true);
    expect(shell.args).toEqual(["-c"]);
  });

  it("honors MCP_RELAY_BASH and refreshes a cached choice when the environment changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-override-"));
    const first = join(root, "first-bash");
    const second = join(root, "second-bash");
    for (const [path, label] of [[first, "first"], [second, "second"]] as const) {
      writeFileSync(path, `#!/bin/sh\nprintf '${label}|'\nexec /bin/bash "$@"\n`, { mode: 0o755 });
    }
    try {
      vi.stubEnv("MCP_RELAY_BASH", first);
      expect(resolveShell().path).toBe(first);
      vi.stubEnv("MCP_RELAY_BASH", second);
      expect(resolveShell().path).toBe(second);
      const result = await runShell(root, "if shopt -q login_shell; then exit 9; fi; printf ok", undefined, 2000);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("second|ok");
      expect(shellEnvironment().MCP_RELAY_BASH).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves an override command through a relative PATH entry", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-path-"));
    const executable = join(root, "custom-bash");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      vi.stubEnv("MCP_RELAY_BASH", "custom-bash");
      vi.stubEnv("PATH", relative(process.cwd(), root));
      expect(resolveShell().path).toBe(executable);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a relative override anchored when the command uses a different cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-relative-"));
    const childDir = join(root, "child");
    const override = join(root, "relative-bash");
    mkdirSync(childDir);
    writeFileSync(override, "#!/bin/sh\nprintf 'selected-shell|'\nexec /bin/bash \"$@\"\n", { mode: 0o755 });
    try {
      // Use a real isolated cwd and './...' override. A long '../...' path can
      // accidentally reach the same file from two different working dirs.
      const command = "printf '%s' \"$PWD\"";
      const code = `import { runShell, resolveShell } from ${JSON.stringify(new URL("../src/shell.ts", import.meta.url).href)};
const result = await runShell(process.cwd(), ${JSON.stringify(command)}, "child", 2000);
console.log(JSON.stringify({ shell: resolveShell(), result }));`;
      const child = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", code], {
        cwd: root, env: { ...process.env, MCP_RELAY_BASH: "./relative-bash" }, encoding: "utf8", timeout: 5000
      });
      expect(child.status, child.stderr).toBe(0);
      const { shell, result } = JSON.parse(child.stdout);
      expect(shell.path).toBe(override);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`selected-shell|${childDir}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("skips non-executable files and directories, falling back to PREFIX/bin/bash", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-prefix-"));
    const bin = join(root, "bin");
    const prefixBash = join(bin, "bash");
    const override = join(root, "override-bash");
    mkdirSync(bin);
    writeFileSync(prefixBash, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      vi.stubEnv("PREFIX", root);
      vi.stubEnv("MCP_RELAY_BASH", override);
      expect(resolveShell().path).toBe(override);
      chmodSync(override, 0o600);
      expect(resolveShell().path).toBe(prefixBash);
      vi.stubEnv("MCP_RELAY_BASH", bin);
      expect(resolveShell().path).toBe(prefixBash);
      expect(shellEnvironment().PREFIX).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
