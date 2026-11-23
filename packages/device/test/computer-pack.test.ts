import { describe, expect, it, vi } from "vitest";
import { createComputerPack } from "../src/packs/computer.js";
import { ComputerError, type ComputerBackend, type ComputerDisplay, type ComputerState } from "../src/computer/types.js";
import type { ComputerSettings } from "../src/computer/settings.js";
import type { PackContext } from "../src/pack.js";

const ctx: PackContext = { root: "/", allowShell: false, allowKernel: false, log: () => {} };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=", "base64");
function fixture() {
  let time = Date.now();
  let settings: ComputerSettings = { schema: 1, enabled: true, paused: false };
  const display: ComputerDisplay = { id: "main", x: -20, y: 0, width: 1, height: 1, scaleX: 2, scaleY: 2 };
  const state: ComputerState = { platform: "linux", backend: "test", available: true, displayKind: "virtual",
    inputKind: "mouse_keyboard", displays: [display], actions: ["click", "move", "drag", "scroll", "key", "text"],
    unicodeText: true, permissions: { input: "granted" }, app: { id: "test-app" } };
  const act = vi.fn(async () => ({ submitted: true, verified: false }));
  const inspect = vi.fn(async () => state);
  const screenshot = vi.fn(async () => ({ data: png, mimeType: "image/png" as const,
    display: { ...display }, capturedAt: time, app: { id: "test-app" } }));
  const release = vi.fn(async () => {});
  const backend: ComputerBackend = { id: "test", inspect, screenshot, act };
  const pack = createComputerPack({ configPath: "/unused", backend, now: () => time,
    settings: () => settings, saveSettings: change => (settings = { ...settings, ...change }),
    lock: async () => release });
  async function frame(): Promise<string> {
    const result = await pack.call("computer_screenshot", {}, ctx);
    expect(result.isError).not.toBe(true);
    return (result.structuredContent as { frame_id: string }).frame_id;
  }
  return { pack, state, display, act, inspect, screenshot, release, frame,
    advance: (ms: number) => { time += ms; }, setSettings: (s: Partial<ComputerSettings>) => { settings = { ...settings, ...s }; } };
}
function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("computer pack observation and action contract", () => {
  it("returns one native image without duplicating its base64 in metadata", async () => {
    const f = fixture();
    const result = await f.pack.call("computer_screenshot", {}, ctx);
    expect(result.content.filter(item => item.type === "image")).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ mimeType: "image/png", data: png.toString("base64") });
    expect(JSON.stringify(result.structuredContent)).not.toContain(png.toString("base64"));
    expect(data(result).coordinate_space).toBe("screenshot_pixels");
  });
  it("executes a Unicode action once and returns cached receipt on exact retry", async () => {
    const f = fixture(), frame_id = await f.frame();
    const input = { frame_id, request_id: "unicode-1", action: { type: "text", text: "你好 🪷" } };
    const first = await f.pack.call("computer_action", input, ctx);
    expect(first.isError).not.toBe(true);
    const again = await f.pack.call("computer_action", input, ctx);
    expect(again.isError).not.toBe(true); expect(f.act).toHaveBeenCalledTimes(1);
    expect(again.content.some(item => typeof item.text === "string" && item.text.includes("not replayed"))).toBe(true);
  });
  it("rejects a reused request id with different payload", async () => {
    const f = fixture(), frame_id = await f.frame();
    await f.pack.call("computer_action", { frame_id, request_id: "one", action: { type: "click", x: 0, y: 0 } }, ctx);
    const result = await f.pack.call("computer_action", { frame_id, request_id: "one", action: { type: "text", text: "different" } }, ctx);
    expect(data(result).code).toBe("request_id_conflict"); expect(f.act).toHaveBeenCalledTimes(1);
  });
  it("consumes observations after an action", async () => {
    const f = fixture(), frame_id = await f.frame();
    await f.pack.call("computer_action", { frame_id, request_id: "a", action: { type: "key", keys: ["Tab"] } }, ctx);
    const result = await f.pack.call("computer_action", { frame_id, request_id: "b", action: { type: "key", keys: ["Tab"] } }, ctx);
    expect(data(result).code).toBe("stale_frame"); expect(f.act).toHaveBeenCalledTimes(1);
  });
  it("rejects expired, foreign and out of bounds frames before input", async () => {
    const f = fixture(), frame_id = await f.frame();
    const outside = await f.pack.call("computer_action", { frame_id, request_id: "out", action: { type: "click", x: 1, y: 0 } }, ctx);
    expect(data(outside).code).toBe("coordinate_out_of_bounds");
    f.advance(120001);
    const stale = await f.pack.call("computer_action", { frame_id, request_id: "expired", action: { type: "click", x: 0, y: 0 } }, ctx);
    expect(data(stale).code).toBe("stale_frame");
    expect(f.act).not.toHaveBeenCalled();
  });
  it("rejects display rotation/scaling and focus changes", async () => {
    const f = fixture(), frame_id = await f.frame();
    f.display.rotation = 90;
    const rotated = await f.pack.call("computer_action", { frame_id, request_id: "rotate", action: { type: "click", x: 0, y: 0 } }, ctx);
    expect(data(rotated).code).toBe("display_changed");
    const next = await f.frame();
    f.state.app = { id: "other-app" };
    const focus = await f.pack.call("computer_action", { frame_id: next, request_id: "focus", action: { type: "text", text: "test" } }, ctx);
    expect(data(focus).code).toBe("focus_changed"); expect(f.act).not.toHaveBeenCalled();
  });
  it("persists handoff, permits observation while paused, and invalidates old frames", async () => {
    const f = fixture(), old = await f.frame();
    await f.pack.call("computer_handoff", { mode: "pause" }, ctx);
    const paused = await f.pack.call("computer_action", { frame_id: old, request_id: "paused", action: { type: "key", keys: ["Tab"] } }, ctx);
    expect(data(paused).code).toBe("computer_paused");
    await f.frame();
    await f.pack.call("computer_handoff", { mode: "resume" }, ctx);
    const resumed = await f.pack.call("computer_action", { frame_id: old, request_id: "resumed", action: { type: "key", keys: ["Tab"] } }, ctx);
    expect(data(resumed).code).toBe("stale_frame");
  });
  it("keeps an ambiguous failure receipt and never replays input", async () => {
    const f = fixture(), frame_id = await f.frame();
    f.act.mockRejectedValue(new ComputerError("timeout", "Timed out", { mayHaveApplied: true }));
    const input = { frame_id, request_id: "ambiguous", action: { type: "text", text: "once" } };
    const result = await f.pack.call("computer_action", input, ctx);
    expect(data(result)).toMatchObject({ mayHaveApplied: true, requires_new_frame: true, code: "timeout" });
    await f.pack.call("computer_action", input, ctx);
    expect(f.act).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalled();
  });
  it("does not turn failed after-screenshot into a failed input receipt", async () => {
    const f = fixture(), frame_id = await f.frame();
    f.screenshot.mockRejectedValue(new ComputerError("capture_failed", "Failed"));
    const input = { frame_id, request_id: "observed", action: { type: "click", x: 0, y: 0 }, screenshot_after: true };
    const result = await f.pack.call("computer_action", input, ctx);
    expect(result.isError).not.toBe(true); expect(data(result).ok).toBe(true);
    expect(data(result).screenshot_error).toBe("capture_failed");
    await f.pack.call("computer_action", input, ctx); expect(f.act).toHaveBeenCalledTimes(1);
  });
  it("disabled control never opens desktop or captures image", async () => {
    const f = fixture(); f.setSettings({ enabled: false });
    expect(data(await f.pack.call("computer_info", {}, ctx)).enabled).toBe(false);
    expect(data(await f.pack.call("computer_screenshot", {}, ctx)).code).toBe("computer_disabled");
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.screenshot).not.toHaveBeenCalled();
  });
  it("waits for cancelled backend cleanup before releasing desktop lock", async () => {
    const f = fixture(), frame_id = await f.frame();
    let cleaned = false;
    f.act.mockImplementation(async (_action?: unknown, _display?: unknown, native?: unknown) => {
      const { signal } = native as { signal: AbortSignal };
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
      cleaned = true;
      throw new ComputerError("cancelled", "Cancelled", { mayHaveApplied: true });
    });
    f.release.mockImplementation(async () => { expect(cleaned).toBe(true); });
    const result = await f.pack.call("computer_action", { frame_id, request_id: "cancel", action: { type: "drag",
      fromX: 0, fromY: 0, toX: 0, toY: 0 }, timeout_ms: 30 }, ctx);
    expect(result.isError).toBe(true); expect(cleaned).toBe(true);
  });
  it("never advertises writes as read-only", () => {
    const f = fixture();
    for (const tool of f.pack.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(["computer_info", "computer_screenshot"].includes(tool.name));
    }
  });
});
