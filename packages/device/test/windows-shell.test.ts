import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ files: new Set<string>() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => fixture.files.has(String(path)) || (/^[A-Z]:\\/i.test(String(path))
      ? false : actual.existsSync(path)),
    statSync: (path: string) => fixture.files.has(String(path)) || /^[A-Z]:\\/i.test(String(path))
      ? { isFile: () => fixture.files.has(String(path)) } : actual.statSync(path)
  };
});
import { resolveShellProgram, runShell, shellEnvironment } from "../src/shell.js";

const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const root = realpathSync(tmpdir());

function child(pid = 7301) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
}

beforeEach(() => {
  fixture.files.clear();
  fixture.files.add(ps);
  vi.mocked(spawn).mockReset();
  vi.stubEnv("SYSTEMROOT", "C:\\Windows");
  vi.stubEnv("PROGRAMFILES", "C:\\Program Files");
  vi.stubEnv("MCP_RELAY_BASH", undefined);
  vi.stubEnv("MCP_RELAY_POWERSHELL", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("preserves Windows runtime paths case-insensitively without forwarding secrets or startup hooks", () => {
  const env = shellEnvironment("win32", {
    Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\bin",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    UserProfile: "C:\\Users\\测试",
    Temp: "C:\\Users\\测试\\Temp",
    PATHEXT: ".EXE;.CMD",
    PSModuleAnalysisCachePath: "C:\\Users\\测试\\Cache\\ModuleAnalysisCache",
    NPM_TOKEN: "do-not-forward",
    AWS_SECRET_ACCESS_KEY: "do-not-forward",
    NODE_OPTIONS: "--require unsafe",
    BASH_ENV: "unsafe",
    LD_PRELOAD: "unsafe"
  });
  expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Program Files\\Git\\bin");
  expect(env.SYSTEMROOT).toBe("C:\\Windows");
  expect(env.USERPROFILE).toBe("C:\\Users\\测试");
  expect(env.TEMP).toBe("C:\\Users\\测试\\Temp");
  expect(env.PSMODULEANALYSISCACHEPATH).toBe("C:\\Users\\测试\\Cache\\ModuleAnalysisCache");
  expect(shellEnvironment("win32", {}).PSMODULEANALYSISCACHEPATH).toBeUndefined();
  expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toHaveLength(1);
  for (const key of ["NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD"]) {
    expect(env[key]).toBeUndefined();
  }
});

it("resolves native PowerShell and Git Bash while excluding the WSL shim", () => {
  const source = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", Path: "C:\\Windows\\System32;C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps" };
  fixture.files.add("C:\\Windows\\System32\\bash.exe");
  fixture.files.add("C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe");
  expect(resolveShellProgram("powershell", "win32", source)).toBe(ps);
  expect(() => resolveShellProgram("bash", "win32", source)).toThrow("use the powershell tool");
  fixture.files.add(gitBash);
  expect(resolveShellProgram("bash", "win32", source)).toBe(gitBash);
  expect(() => resolveShellProgram("bash", "win32", { MCP_RELAY_BASH: "bash.exe" })).toThrow("absolute .exe path");
});

it("binds a relative Windows PATH candidate to the daemon cwd before spawn changes cwd", () => {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\relay");
  try {
    const relative = "bin\\bash.exe";
    const absolute = win32.resolve(relative);
    fixture.files.add(relative);
    fixture.files.add(absolute);
    expect(resolveShellProgram("bash", "win32", { PATH: "bin" })).toBe(absolute);
  } finally { cwd.mockRestore(); }
});

it("excludes an absolute WSL override after resolving dot segments", () => {
  const override = "C:\\Windows\\System32\\..\\System32\\bash.exe";
  fixture.files.add(override);
  fixture.files.add(win32.resolve(override));
  expect(() => resolveShellProgram("bash", "win32", { MCP_RELAY_BASH: override }))
    .toThrow("absolute .exe path");
});

it("passes Unicode and quotes to PowerShell without cmd.exe and decodes split UTF-8 output", async () => {
  const proc = child();
  vi.mocked(spawn).mockReturnValue(proc as never);
  const command = "Write-Output '中文 \"quoted\"'\nWrite-Output 'second line'";
  const running = runShell(root, command, undefined, 10000, undefined, "win32", "powershell");
  const [program, args, options] = vi.mocked(spawn).mock.calls[0]!;
  expect(program).toBe(ps);
  const argv = args as string[];
  expect(argv).toContain("-NoProfile");
  expect(argv).toContain("-NonInteractive");
  const decoded = Buffer.from(argv[argv.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
  expect(decoded).toContain(command);
  expect(decoded).toContain("[Console]::OutputEncoding");
  expect(options).toMatchObject({ cwd: root, detached: false, windowsHide: true });
  const output = Buffer.from("中文🙂", "utf8");
  proc.stdout.emit("data", output.subarray(0, 2));
  proc.stdout.emit("data", output.subarray(2, 5));
  proc.stdout.emit("data", output.subarray(5));
  proc.emit("close", 0, null);
  expect(await running).toMatchObject({ exitCode: 0, stdout: "中文🙂", stderr: "", timedOut: false });
});

it("keeps Bash syntax intact on Windows when a native Bash exists", async () => {
  fixture.files.add(gitBash);
  const proc = child();
  vi.mocked(spawn).mockReturnValue(proc as never);
  const command = "printf '%s' \"$HOME\"";
  const running = runShell(root, command, undefined, 10000, undefined, "win32", "bash");
  expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(gitBash);
  expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(["--noprofile", "--norc", "-c", command]);
  proc.emit("close", 0, null);
  await running;
});

it("terminates the Windows process tree on cancellation and waits for taskkill to complete", async () => {
  const proc = child();
  const killer = child(7302);
  vi.mocked(spawn).mockReturnValueOnce(proc as never).mockReturnValueOnce(killer as never);
  const controller = new AbortController();
  const running = runShell(root, "Start-Sleep 60", undefined, 10000, controller.signal, "win32", "powershell");
  controller.abort();
  expect(vi.mocked(spawn).mock.calls[1]![0]).toBe("C:\\Windows\\System32\\taskkill.exe");
  expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(["/PID", "7301", "/T", "/F"]);
  let resolved = false;
  void running.then(() => { resolved = true; });
  proc.emit("close", 1, null);
  await Promise.resolve();
  expect(resolved).toBe(false);
  killer.emit("close", 0, null);
  expect(await running).toMatchObject({ timedOut: true });
});

it("also terminates a Windows process tree on its execution deadline", async () => {
  vi.useFakeTimers();
  const proc = child();
  const killer = child(7302);
  vi.mocked(spawn).mockReturnValueOnce(proc as never).mockReturnValueOnce(killer as never);
  const running = runShell(root, "Start-Sleep 60", undefined, 1000, undefined, "win32", "powershell");
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(["/PID", "7301", "/T", "/F"]);
  killer.emit("close", 0, null);
  proc.emit("close", 1, null);
  expect((await running).timedOut).toBe(true);
});

it("rejects a cwd outside the device root and a pre-aborted call before launching anything", () => {
  expect(() => runShell(root, "Write-Output bad", "..", 1000, undefined, "win32", "powershell"))
    .toThrow("path escapes root");
  const controller = new AbortController();
  controller.abort();
  expect(() => runShell(root, "Write-Output bad", undefined, 1000, controller.signal, "win32", "powershell")).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
