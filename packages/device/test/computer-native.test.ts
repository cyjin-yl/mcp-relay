import { describe, expect, it } from "vitest";
import { nativeEnvironment, pngDimensions, runNative } from "../src/computer/native.js";
describe("native UI command boundaries", () => {
  it("passes Unicode on stdin without shell parsing and retains binary stdout", async () => {
    const input = "中文 🧪 $(touch /should-not-exist)\n' \"";
    const result = await runNative({ command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"], input }, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString("utf8")).toBe(input);
  });
  it("filters credentials but retains desktop connection variables", () => {
    const env = nativeEnvironment({ PATH: "/bin", HOME: "/home/test", DISPLAY: ":77",
      XAUTHORITY: "/home/test/.Xauthority", OPENAI_API_KEY: "secret", LD_PRELOAD: "secret" });
    expect(env.DISPLAY).toBe(":77"); expect(env.XAUTHORITY).toContain("Xauthority");
    expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.LD_PRELOAD).toBeUndefined();
  });
  it("rejects excess output and observes process exit before returning", async () => {
    await expect(runNative({ command: process.execPath, args: ["-e",
      "process.stdout.write(Buffer.alloc(4096)); setInterval(()=>{},1000)"], maxOutputBytes: 64 },
    { timeoutMs: 5000 })).rejects.toMatchObject({ code: "output_too_large" });
  });
  it("cancels a running child and bounds inherited open pipes", async () => {
    const controller = new AbortController();
    const promise = runNative({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
      { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    const result = await runNative({ command: process.execPath, args: ["-e",
      "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},800)'],{stdio:['ignore',1,2]});c.unref()"] },
      { timeoutMs: 3000 });
    expect(result.exitCode).toBe(0);
  });
  it("fails closed on invalid or oversized PNG dimensions", () => {
    expect(() => pngDimensions(Buffer.from("not png"))).toThrow();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=", "base64");
    expect(pngDimensions(png)).toEqual({ width: 1, height: 1 });
    png.writeUInt32BE(50000, 16); expect(() => pngDimensions(png)).toThrow();
  });
});
