import { beforeEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  runShell: vi.fn(),
  shellAvailable: vi.fn(() => true)
}));
vi.mock("../src/shell.js", () => mocked);
import { createMinimalPack } from "../src/packs/minimal.js";
import type { PackContext } from "../src/pack.js";

const ctx: PackContext = {
  root: "/relay-test-root",
  allowShell: true,
  allowKernel: false,
  log: () => {}
};
const output = (result: Awaited<ReturnType<ReturnType<typeof createMinimalPack>["call"]>>) =>
  result.content.map((part) => part.type === "text" ? part.text : "").join("\n");

beforeEach(() => {
  mocked.runShell.mockReset().mockResolvedValue({
    exitCode: 0, signal: null, stdout: "ok", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, timedOut: false
  });
  mocked.shellAvailable.mockReset().mockReturnValue(true);
});

it("advertises native PowerShell and omits unavailable Windows Bash", () => {
  mocked.shellAvailable.mockImplementation((kind: string) => kind === "powershell");
  const pack = createMinimalPack("win32");
  expect(pack.tools.map((tool) => tool.name)).toContain("powershell");
  expect(pack.tools.map((tool) => tool.name)).toContain("powershell_confirm");
  expect(pack.tools.map((tool) => tool.name)).not.toContain("bash");
  expect(pack.tools.map((tool) => tool.name)).not.toContain("bash_confirm");
  expect(createMinimalPack("linux").tools.map((tool) => tool.name)).not.toContain("powershell");
});

it("routes PowerShell explicitly with cwd, timeout, cancellation and shell authorization intact", async () => {
  const pack = createMinimalPack("win32");
  const controller = new AbortController();
  const result = await pack.call("powershell", { command: "Write-Output '中文'", cwd: "project", timeout_ms: 5000 },
    { ...ctx, signal: controller.signal });
  expect(result.isError).not.toBe(true);
  expect(mocked.runShell).toHaveBeenCalledWith(ctx.root, "Write-Output '中文'", "project", 5000,
    controller.signal, "win32", "powershell");
  mocked.runShell.mockClear();
  const denied = await pack.call("powershell", { command: "Write-Output bad" }, { ...ctx, allowShell: false });
  expect(output(denied)).toContain("shell tool is disabled");
  expect(mocked.runShell).not.toHaveBeenCalled();
});

it("requires confirmation for case-insensitive PowerShell destructive commands and binds the token to its shell", async () => {
  const pack = createMinimalPack("win32");
  const command = "REMOVE-ITEM -LiteralPath 'disposable' -Recurse";
  const request = await pack.call("powershell", { command, cwd: "project", timeout_ms: 7000 }, ctx);
  expect(request.isError).toBe(true);
  expect(output(request)).toContain("powershell_confirm");
  const token = /token ([A-Za-z0-9_-]+) and/.exec(output(request))?.[1];
  expect(token).toBeTruthy();
  expect(mocked.runShell).not.toHaveBeenCalled();

  const wrongShell = await pack.call("bash_confirm", { token: token!, command }, ctx);
  expect(output(wrongShell)).toContain("different shell");
  expect(mocked.runShell).not.toHaveBeenCalled();
  const changed = await pack.call("powershell_confirm", { token: token!, command: command + " -Force" }, ctx);
  expect(output(changed)).toContain("does not match");
  expect(mocked.runShell).not.toHaveBeenCalled();

  const confirmed = await pack.call("powershell_confirm", { token: token!, command }, ctx);
  expect(confirmed.isError).not.toBe(true);
  expect(mocked.runShell).toHaveBeenCalledWith(ctx.root, command, "project", 7000, undefined, "win32", "powershell");
  const reused = await pack.call("powershell_confirm", { token: token!, command }, ctx);
  expect(output(reused)).toContain("missing or expired");
  expect(mocked.runShell).toHaveBeenCalledTimes(1);
});

it("does not silently interpret PowerShell as Bash on other platforms", async () => {
  const result = await createMinimalPack("linux").call("powershell", { command: "Get-Location" }, ctx);
  expect(output(result)).toContain("available only on Windows");
  expect(mocked.runShell).not.toHaveBeenCalled();
});

it.each([
  "Remove-Item 'disposable'",
  "rM 'disposable'",
  "ri 'disposable'",
  "del 'disposable'",
  "Clear-Content 'disposable'",
  "clc 'disposable'",
  "Stop-Process -Id 999999",
  "kill 999999",
  "spps -Id 999999",
  "taskkill /PID 999999 /T /F",
  "FORMAT D:",
  "Format-Volume -DriveLetter D"
])("requires the existing confirmation flow for destructive PowerShell command %s", async (command) => {
  const result = await createMinimalPack("win32").call("powershell", { command }, ctx);
  expect(output(result)).toContain("powershell_confirm");
  expect(result.isError).toBe(true);
  expect(mocked.runShell).not.toHaveBeenCalled();
});

it("allows ordinary PowerShell formatting without a destructive-command false positive", async () => {
  const result = await createMinimalPack("win32").call("powershell", { command: "Get-Process | Format-Table" }, ctx);
  expect(result.isError).not.toBe(true);
  expect(mocked.runShell).toHaveBeenCalledTimes(1);
});
