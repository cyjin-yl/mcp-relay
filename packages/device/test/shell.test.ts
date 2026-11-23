import { describe, expect, it } from "vitest";
import { resolveShell } from "../src/shell.js";

describe("shell resolution", () => {
  it("selects an executable bash/sh and matching arguments", () => {
    if (process.platform === "win32") return;
    const shell = resolveShell();
    expect(shell.path.startsWith("/")).toBe(true);
    expect(shell.args).toEqual(/bash$/i.test(shell.path) ? ["--noprofile", "--norc", "-c"] : ["-c"]);
  });
});


it("honors an explicit POSIX sh override with sh-compatible arguments", () => {
  if (process.platform === "win32") return;
  const shell = resolveShell(process.platform, { MCP_RELAY_BASH: "/bin/sh", PATH: "/nonexistent" });
  expect(shell.path).toBe("/bin/sh");
  expect(shell.args).toEqual(["-c"]);
});

it("does not silently ignore a broken explicit shell override", () => {
  if (process.platform === "win32") return;
  expect(() => resolveShell(process.platform, { MCP_RELAY_BASH: "/nonexistent/relay-shell" })).toThrow(/MCP_RELAY_BASH/);
});
