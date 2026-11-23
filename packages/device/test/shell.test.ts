import { describe, expect, it } from "vitest";
import { resolveShell } from "../src/shell.js";

describe("shell resolution", () => {
  it("selects an executable bash/sh and matching arguments", () => {
    if (process.platform === "win32") return;
    const shell = resolveShell();
    expect(shell.path.startsWith("/")).toBe(true);
    expect(shell.args).toEqual([/bash$/i.test(shell.path) ? "-lc" : "-c"]);
  });
});
