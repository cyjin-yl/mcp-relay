import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const shellModule = new URL("../src/shell.ts", import.meta.url).href;

for (const fixture of [
  { name: "explicit relative override", path: "relative-shell", env: { MCP_RELAY_BASH: "./relative-shell" } },
  { name: "relative PATH entry", path: "bin/bash", env: { MCP_RELAY_BASH: "bash", PATH: "./bin" } },
  { name: "relative PREFIX", path: "termux/bin/bash", env: { PREFIX: "./termux" } }
]) {
  it.skipIf(process.platform === "win32")("runs the validated " + fixture.name + " after changing cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-cwd-"));
    const child = join(root, "child");
    try {
      // Both files are executable. The tool cwd contains a same-name program
      // that was never selected or checked by the daemon's resolver.
      for (const [base, marker] of [[root, "validated-shell"], [child, "wrong-shell"]] as const) {
        const file = join(base, fixture.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "#!/bin/sh\nprintf '" + marker + "\\n'\nexec /bin/bash \"$@\"\n", { mode: 0o755 });
      }
      const environment = { ...process.env };
      delete environment.MCP_RELAY_BASH;
      delete environment.PREFIX;
      Object.assign(environment, fixture.env);
      const source = "import { runShell } from " + JSON.stringify(shellModule) + ";\n" +
        "const result = await runShell(" + JSON.stringify(root) + ", \"printf requested-command\", \"child\", 5000);\n" +
        "process.stdout.write(JSON.stringify(result));";
      const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
        cwd: root, env: environment, encoding: "utf8", timeout: 10000
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        exitCode: 0, stdout: "validated-shell\nrequested-command", stderr: "", timedOut: false
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
